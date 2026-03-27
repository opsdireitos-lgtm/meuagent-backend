const { supabase } = require("../config/supabase");
const { bulkCircuit } = require("../services/circuit-breaker");
const { sleep } = require("../services/presence");
const logger = require("../services/logger");

const POLL_INTERVAL = parseInt(process.env.BULK_POLL_INTERVAL || "60000");

async function processBulkCampaigns() {
  const check = bulkCircuit.check();
  if (!check.allowed) return;

  try {
    const now = new Date().toISOString();

    const { data: scheduledCampaigns } = await supabase
      .from("bulk_campaigns")
      .select("id")
      .eq("status", "scheduled")
      .lte("scheduled_at", now);

    const { data: stalledCampaigns } = await supabase
      .from("bulk_campaigns")
      .select("id")
      .eq("status", "running");

    const campaigns = [...(scheduledCampaigns || []), ...(stalledCampaigns || [])];
    if (!campaigns.length) { bulkCircuit.recordSuccess(); return; }

    bulkCircuit.recordSuccess();

    for (const campaign of campaigns) {
      await supabase.from("bulk_campaigns").update({ status: "running" }).eq("id", campaign.id);
      await executeBulkCampaign(campaign.id);
    }
  } catch (e) {
    bulkCircuit.recordFailure();
    await logger.error("Bulk", "Worker error", { error: e.message });
  }
}

async function executeBulkCampaign(campaignId) {
  const { data: campaign } = await supabase
    .from("bulk_campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (!campaign || campaign.status !== "running") return;

  const { data: agent } = await supabase
    .from("agents")
    .select("evolution_api_url, evolution_api_key, evolution_instance, phone_connected")
    .eq("id", campaign.agent_id)
    .single();

  if (!agent?.evolution_api_url || !agent?.evolution_instance) {
    await supabase.from("bulk_campaigns").update({ status: "failed" }).eq("id", campaignId);
    return;
  }

  // Check time window (Brazil timezone)
  const brTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const currentMinutes = brTime.getHours() * 60 + brTime.getMinutes();
  const [startH, startM] = (campaign.send_window_start || "08:00").split(":").map(Number);
  const [endH, endM] = (campaign.send_window_end || "18:00").split(":").map(Number);
  const windowStart = startH * 60 + startM;
  const windowEnd = endH * 60 + endM;

  if (currentMinutes < windowStart || currentMinutes > windowEnd) return;

  const { data: pendingContacts } = await supabase
    .from("bulk_campaign_contacts")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);

  if (!pendingContacts?.length) {
    await supabase.from("bulk_campaigns").update({ status: "completed" }).eq("id", campaignId);
    return;
  }

  const baseDelayMs = Math.max(campaign.delay_between_ms || 5000, 3000);
  let sentCount = campaign.sent_count || 0;
  let failedCount = campaign.failed_count || 0;
  const evoUrl = agent.evolution_api_url.replace(/\/$/, "");
  const mediaType = campaign.media_type || "text";
  const mediaUrl = campaign.media_url || "";
  const variations = Array.isArray(campaign.message_variations) ? campaign.message_variations.filter((v) => v?.trim()) : [];
  let variationIndex = 0;

  for (const contact of pendingContacts) {
    // Re-check campaign status
    const { data: freshCampaign } = await supabase.from("bulk_campaigns").select("status").eq("id", campaignId).single();
    if (freshCampaign?.status !== "running") break;

    // Re-check time window
    const nowCheck = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const curMin = nowCheck.getHours() * 60 + nowCheck.getMinutes();
    if (curMin < windowStart || curMin > windowEnd) {
      await supabase.from("bulk_campaigns").update({ status: "paused" }).eq("id", campaignId);
      break;
    }

    let prefix = "";
    if (variations.length > 0) {
      prefix = variations[variationIndex % variations.length].replace(/\{nome\}/gi, contact.contact_name || "Olá");
      variationIndex++;
    }

    const baseMessage = (campaign.message_content || "").replace(/\{nome\}/gi, contact.contact_name || "Olá");
    const personalizedMessage = prefix ? `${prefix}\n\n${baseMessage}` : baseMessage;
    const phone = contact.contact_phone.replace(/\D/g, "");

    try {
      let sendRes;
      const headers = { "Content-Type": "application/json", apikey: agent.evolution_api_key };

      if (mediaType === "text") {
        sendRes = await fetch(`${evoUrl}/message/sendText/${agent.evolution_instance}`, {
          method: "POST", headers, body: JSON.stringify({ number: phone, text: personalizedMessage }),
        });
      } else if (mediaType === "image") {
        sendRes = await fetch(`${evoUrl}/message/sendMedia/${agent.evolution_instance}`, {
          method: "POST", headers,
          body: JSON.stringify({ number: phone, mediatype: "image", media: mediaUrl, caption: personalizedMessage || undefined }),
        });
      } else if (mediaType === "audio") {
        sendRes = await fetch(`${evoUrl}/message/sendWhatsAppAudio/${agent.evolution_instance}`, {
          method: "POST", headers, body: JSON.stringify({ number: phone, audio: mediaUrl }),
        });
      } else if (mediaType === "document") {
        const fileName = mediaUrl.split("/").pop() || "documento";
        sendRes = await fetch(`${evoUrl}/message/sendMedia/${agent.evolution_instance}`, {
          method: "POST", headers,
          body: JSON.stringify({ number: phone, mediatype: "document", media: mediaUrl, fileName, caption: personalizedMessage || undefined }),
        });
      } else {
        sendRes = await fetch(`${evoUrl}/message/sendText/${agent.evolution_instance}`, {
          method: "POST", headers, body: JSON.stringify({ number: phone, text: personalizedMessage }),
        });
      }

      if (sendRes.ok) {
        sentCount++;
        await supabase.from("bulk_campaign_contacts").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", contact.id);
      } else {
        const errText = await sendRes.text();
        failedCount++;
        await supabase.from("bulk_campaign_contacts").update({ status: "failed", error_message: errText.slice(0, 500) }).eq("id", contact.id);
      }
    } catch (e) {
      failedCount++;
      await supabase.from("bulk_campaign_contacts").update({ status: "failed", error_message: e.message?.slice(0, 500) }).eq("id", contact.id);
    }

    await supabase.from("bulk_campaigns").update({ sent_count: sentCount, failed_count: failedCount, last_sent_phone: contact.contact_phone }).eq("id", campaignId);

    const randomDelay = Math.round(baseDelayMs * (0.67 + Math.random() * 0.66));
    await sleep(randomDelay);
  }

  // Check completion
  const { data: remaining } = await supabase
    .from("bulk_campaign_contacts")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .limit(1);

  if (!remaining?.length) {
    const { data: freshStatus } = await supabase.from("bulk_campaigns").select("status").eq("id", campaignId).single();
    if (freshStatus?.status === "running") {
      await supabase.from("bulk_campaigns").update({ status: "completed" }).eq("id", campaignId);
    }
  }
}

let bulkTimer = null;

function startBulkWorker() {
  console.log(`[Bulk] Worker started (interval: ${POLL_INTERVAL}ms)`);
  processBulkCampaigns();
  bulkTimer = setInterval(processBulkCampaigns, POLL_INTERVAL);
}

function stopBulkWorker() {
  if (bulkTimer) clearInterval(bulkTimer);
}

module.exports = { startBulkWorker, stopBulkWorker };
