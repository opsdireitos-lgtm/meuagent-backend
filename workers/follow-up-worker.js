const { supabase } = require("../config/supabase");
const { followUpCircuit } = require("../services/circuit-breaker");
const { executeFlowNodes } = require("../services/automation-executor");
const { sleep } = require("../services/presence");
const logger = require("../services/logger");

const STALE_LOCK_MINUTES = parseInt(process.env.STALE_LOCK_MINUTES || "5");
const POLL_INTERVAL = parseInt(process.env.FOLLOW_UP_POLL_INTERVAL || "30000");

const JS_DAY_TO_CODE = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

function isScheduledNow(followUpConfig) {
  const mode = followUpConfig.schedule_mode || "delay";
  if (mode !== "scheduled") return { allowed: true };

  const now = new Date();
  const scheduledDays = followUpConfig.scheduled_days || [];
  const scheduledTime = followUpConfig.scheduled_time || null;

  if (scheduledDays.length > 0) {
    const todayCode = JS_DAY_TO_CODE[now.getUTCDay()];
    if (!scheduledDays.includes(todayCode)) return { allowed: false, reason: "not_scheduled_day" };
  }

  if (scheduledTime) {
    const [hours, minutes] = scheduledTime.split(":").map(Number);
    const scheduledMinutes = hours * 60 + minutes;
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const diff = Math.abs(nowMinutes - scheduledMinutes);
    if (diff > 30 && diff < 1410) return { allowed: false, reason: "outside_time_window" };
  }

  return { allowed: true };
}

function calculateNextScheduledTime(time, days) {
  const [hours, minutes] = time.split(":").map(Number);
  const candidate = new Date();
  candidate.setUTCHours(hours, minutes, 0, 0);
  if (candidate <= new Date()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  if (days.length === 0) return candidate.toISOString();
  for (let i = 0; i < 7; i++) {
    const dayCode = JS_DAY_TO_CODE[candidate.getUTCDay()];
    if (days.includes(dayCode)) return candidate.toISOString();
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

async function processFollowUps() {
  const check = followUpCircuit.check();
  if (!check.allowed) {
    console.warn(`[FollowUp] circuit open: ${check.reason}`);
    return;
  }

  try {
    const now = new Date().toISOString();

    // Auto-release stale locks
    const staleCutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000).toISOString();
    const { data: staleItems } = await supabase
      .from("follow_up_queue")
      .update({ status: "pending" })
      .eq("status", "processing")
      .lt("created_at", staleCutoff)
      .select("id");

    if (staleItems?.length) {
      await logger.warn("FollowUp", `Released ${staleItems.length} stale locks`);
    }

    // Cancel stuck executions
    const { data: staleExecs } = await supabase
      .from("automation_executions")
      .update({ status: "cancelled", completed_at: now })
      .eq("status", "running")
      .lt("started_at", staleCutoff)
      .select("id");

    if (staleExecs?.length) {
      await logger.warn("FollowUp", `Cancelled ${staleExecs.length} stale executions`);
    }

    followUpCircuit.recordSuccess();

    // Fetch due follow-ups
    const { data: dueFollowUps, error } = await supabase
      .from("follow_up_queue")
      .select("*, automation_follow_ups!inner(is_active, schedule_mode, scheduled_time, scheduled_days)")
      .eq("status", "pending")
      .lte("fire_at", now)
      .order("fire_at", { ascending: true })
      .limit(50);

    if (error) { followUpCircuit.recordFailure(); return; }
    if (!dueFollowUps?.length) return;

    console.log(`[FollowUp] Processing ${dueFollowUps.length} items`);

    for (const item of dueFollowUps) {
      const { id, follow_up_flow_id, agent_id, contact_phone, flow_id, follow_up_id } = item;
      const followUpConfig = item.automation_follow_ups;

      // Atomic lock
      const { data: claimed } = await supabase
        .from("follow_up_queue")
        .update({ status: "processing" })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");

      if (!claimed?.length) continue;

      if (!followUpConfig?.is_active) {
        await supabase.from("follow_up_queue").update({
          status: "cancelled", cancelled_reason: "follow_up_disabled", executed_at: now,
        }).eq("id", id);
        continue;
      }

      const scheduleCheck = isScheduledNow(followUpConfig);
      if (!scheduleCheck.allowed) {
        await supabase.from("follow_up_queue").update({ status: "pending" }).eq("id", id);
        continue;
      }

      // Fetch agent
      const { data: agent } = await supabase
        .from("agents")
        .select("*")
        .eq("id", agent_id)
        .eq("is_active", true)
        .single();

      if (!agent) {
        await supabase.from("follow_up_queue").update({
          status: "cancelled", cancelled_reason: "agent_inactive", executed_at: now,
        }).eq("id", id);
        continue;
      }

      // Find conversation
      const { data: conversation } = await supabase
        .from("conversations")
        .select("id")
        .eq("agent_id", agent_id)
        .eq("contact_phone", contact_phone)
        .eq("is_active", true)
        .maybeSingle();

      // Check if lead responded
      if (conversation) {
        const { data: recentIncoming } = await supabase
          .from("messages")
          .select("id")
          .eq("conversation_id", conversation.id)
          .eq("direction", "incoming")
          .gte("created_at", item.created_at)
          .limit(1);

        if (recentIncoming?.length) {
          await supabase.from("follow_up_queue").update({
            status: "cancelled", cancelled_reason: "lead_responded", executed_at: now,
          }).eq("id", id);

          await supabase.from("follow_up_queue").update({
            status: "cancelled", cancelled_reason: "lead_responded_chain", executed_at: now,
          }).eq("agent_id", agent_id).eq("contact_phone", contact_phone).eq("flow_id", flow_id).eq("status", "pending");
          continue;
        }
      }

      // Execute flow
      const { data: flowNodes } = await supabase
        .from("automation_nodes")
        .select("*")
        .eq("flow_id", follow_up_flow_id)
        .order("sort_order", { ascending: true });

      if (!flowNodes?.length) {
        await supabase.from("follow_up_queue").update({
          status: "cancelled", cancelled_reason: "no_flow_nodes", executed_at: now,
        }).eq("id", id);
        continue;
      }

      const { data: execData } = await supabase.from("automation_executions").insert({
        flow_id: follow_up_flow_id, contact_phone, status: "running",
      }).select("id").single();

      await executeFlowNodes(agent, contact_phone, flowNodes, conversation?.id || null);

      if (execData?.id) {
        await supabase.from("automation_executions").update({
          status: "completed", completed_at: new Date().toISOString(),
        }).eq("id", execData.id);
      }

      await supabase.from("follow_up_queue").update({
        status: "executed", executed_at: new Date().toISOString(),
      }).eq("id", id);

      // Schedule next in chain
      try {
        const { data: currentFu } = await supabase
          .from("automation_follow_ups")
          .select("sort_order")
          .eq("id", follow_up_id)
          .single();

        if (currentFu) {
          const { data: nextFollowUp } = await supabase
            .from("automation_follow_ups")
            .select("*")
            .eq("flow_id", flow_id)
            .eq("is_active", true)
            .gt("sort_order", currentFu.sort_order)
            .order("sort_order", { ascending: true })
            .limit(1)
            .single();

          if (nextFollowUp) {
            const nextMode = nextFollowUp.schedule_mode || "delay";
            const nextFireAt = nextMode === "scheduled"
              ? calculateNextScheduledTime(nextFollowUp.scheduled_time || "09:00:00", nextFollowUp.scheduled_days || [])
              : new Date(Date.now() + nextFollowUp.delay_minutes * 60 * 1000).toISOString();

            await supabase.from("follow_up_queue").insert({
              follow_up_id: nextFollowUp.id,
              flow_id,
              follow_up_flow_id: nextFollowUp.follow_up_flow_id,
              agent_id,
              contact_phone,
              fire_at: nextFireAt,
            });
            console.log(`[FollowUp] Next scheduled: ${nextFollowUp.id} at ${nextFireAt}`);
          }
        }
      } catch (e) {
        await logger.error("FollowUp", "Error scheduling next", { error: e.message });
      }
    }
  } catch (e) {
    followUpCircuit.recordFailure();
    await logger.error("FollowUp", "Worker error", { error: e.message });
  }
}

let followUpTimer = null;

function startFollowUpWorker() {
  console.log(`[FollowUp] Worker started (interval: ${POLL_INTERVAL}ms)`);
  processFollowUps();
  followUpTimer = setInterval(processFollowUps, POLL_INTERVAL);
}

function stopFollowUpWorker() {
  if (followUpTimer) clearInterval(followUpTimer);
}

module.exports = { startFollowUpWorker, stopFollowUpWorker };
