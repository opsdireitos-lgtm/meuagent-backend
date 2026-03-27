const { supabase, getSetting } = require("../config/supabase");
const { isDuplicate, tryAcquireAILock, releaseAILock } = require("../config/redis");
const { webhookCircuit } = require("../services/circuit-breaker");
const { query } = require("../config/database");
const logger = require("../services/logger");
const {
  sendTextMessage, sendImageMessage, sendAudioFileMessage,
  sendVideoMessage, sendDocumentMessage, sendStickerMessage,
  sendContactMessage, sendLocationMessage, sendButtonsMessage,
  fetchMediaBase64,
} = require("../services/evolution-api");
const {
  waitWithPresence, estimateTypingDelayMs,
  startPresenceHeartbeat, sleep,
} = require("../services/presence");
const { extractMessageData, transcribeAudio, buildAIMessages, callAI, getApiKeyForModel } = require("../services/ai");
const { executeFlowNodes } = require("../services/automation-executor");

async function webhookController(req, res) {
  const cbCheck = webhookCircuit.check();
  if (!cbCheck.allowed) {
    return res.status(503).json({ status: "circuit_open", reason: cbCheck.reason });
  }

  try {
    const body = req.body;
    const event = body.event;
    if (event !== "messages.upsert") return res.json({ status: "ignored" });

    const message = body.data;
    if (!message || message.key?.fromMe) return res.json({ status: "skipped" });

    const instanceName = body.instance;
    const remoteJid = message.key?.remoteJid;
    const messageId = message.key?.id;

    const msgData = extractMessageData(message);
    const trimmedText = (msgData.text || "").trim();
    const rawMessage = message.message || {};
    const hasUsefulContent = Boolean(trimmedText || rawMessage.imageMessage || rawMessage.audioMessage);
    const isSystemPayload = Boolean(rawMessage.senderKeyDistributionMessage || rawMessage.protocolMessage);
    const isAckOnly = message.status === "DELIVERY_ACK" && !hasUsefulContent;

    if (isSystemPayload || isAckOnly || !hasUsefulContent) {
      return res.json({ status: "skipped_non_processable" });
    }

    if (!remoteJid) return res.json({ status: "no_jid" });

    // Deduplication via Redis
    if (messageId && await isDuplicate(messageId)) {
      return res.json({ status: "deduplicated" });
    }

    const isGroup = remoteJid.endsWith("@g.us");
    const phone = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
    const contactName = message.pushName || phone;

    // Find agent
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, user_id, name, is_active, evolution_api_url, evolution_api_key, evolution_instance, system_prompt, personality, ai_model, ai_enabled, response_delay_ms, typing_simulation, reply_groups, reply_saved_contacts, reply_unsaved_contacts, reply_with_audio, audio_percentage, elevenlabs_voice_id, test_mode, test_numbers, use_cases, activate_ai_after_flow, use_own_api_key, custom_anthropic_key")
      .eq("evolution_instance", instanceName)
      .eq("is_active", true)
      .single();

    if (agentError || !agent) {
      if (agentError) webhookCircuit.recordFailure();
      return res.json({ status: "no_agent" });
    }

    webhookCircuit.recordSuccess();

    // Log to local PostgreSQL
    await query(
      "INSERT INTO messages (agent_id, phone, direction, content, message_id_ext, processed) VALUES ($1, $2, $3, $4, $5, $6)",
      [agent.id, phone, "incoming", msgData.text || "[media]", messageId, false]
    ).catch(() => {});

    // Test mode filter
    const testMode = agent.test_mode === true;
    const testNumbers = agent.test_numbers || [];
    let isWhitelisted = false;
    if (testMode) {
      isWhitelisted = testNumbers.some((tn) => phone.includes(tn) || tn.includes(phone));
      if (!isWhitelisted) return res.json({ status: "test_mode_filtered" });
    }

    // Contact type filter
    if (!isWhitelisted) {
      if (isGroup && !agent.reply_groups) return res.json({ status: "groups_disabled" });
      if (!isGroup) {
        const isKnownContact = !!message.pushName && message.pushName !== phone;
        if (isKnownContact && !agent.reply_saved_contacts) return res.json({ status: "saved_contacts_disabled" });
        if (!isKnownContact && !agent.reply_unsaved_contacts) return res.json({ status: "unsaved_contacts_disabled" });
      }
    }

    // Check user blocked
    const { data: profile } = await supabase.from("profiles").select("is_blocked").eq("id", agent.user_id).single();
    if (profile?.is_blocked) return res.json({ status: "user_blocked" });

    // Fetch media if needed
    let imageBase64 = msgData.imageBase64;
    let audioBase64 = msgData.audioBase64;
    if (msgData.type === "image" && !imageBase64) imageBase64 = await fetchMediaBase64(agent, message);
    if (msgData.type === "audio" && !audioBase64) audioBase64 = await fetchMediaBase64(agent, message);

    // Pre-fetch OpenAI key for whisper/vision
    let cachedOpenaiKey = "";
    if (msgData.type === "audio" || msgData.type === "image") {
      const { data: openaiKeys } = await supabase
        .from("api_keys")
        .select("api_key")
        .eq("provider", "openai")
        .eq("is_active", true)
        .or(`cooldown_until.is.null,cooldown_until.lt.${new Date().toISOString()}`)
        .limit(1);
      cachedOpenaiKey = openaiKeys?.[0]?.api_key || "";
      if (!cachedOpenaiKey) cachedOpenaiKey = await getSetting("OPENAI_API_KEY") || "";
    }

    // Transcribe audio
    let transcribedAudio = "";
    if (msgData.type === "audio" && audioBase64) {
      transcribedAudio = cachedOpenaiKey
        ? await transcribeAudio(audioBase64, msgData.audioMimetype, cachedOpenaiKey)
        : "[áudio recebido - transcrição indisponível]";
    }

    let savedContent = msgData.text;
    if (msgData.type === "image") savedContent = msgData.imageCaption || "[📷 Imagem]";
    if (msgData.type === "audio") savedContent = transcribedAudio ? `[🎤 Áudio]: ${transcribedAudio}` : "[🎤 Áudio]";

    // Upsert conversation
    let conversation = null;
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id, ai_disabled")
      .eq("agent_id", agent.id)
      .eq("contact_phone", phone)
      .eq("is_active", true)
      .maybeSingle();

    if (existingConv) {
      conversation = existingConv;
      await supabase.from("conversations").update({
        contact_name: contactName !== phone ? contactName : undefined,
        last_message_at: new Date().toISOString(),
      }).eq("id", existingConv.id);
    } else {
      const { data: newConv } = await supabase.from("conversations").insert({
        agent_id: agent.id, contact_phone: phone,
        contact_name: contactName !== phone ? contactName : null,
        last_message_at: new Date().toISOString(),
      }).select("id, ai_disabled").single();
      conversation = newConv;
    }

    if (!conversation) return res.status(500).json({ error: "conversation_create_failed" });

    // Save incoming message to Supabase
    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      direction: "incoming",
      content: savedContent,
    });

    // Update phone_connected
    if (!isGroup && agent.connection_status === "connected") {
      await supabase.from("agents").update({ phone_connected: phone }).eq("id", agent.id);
    }

    // CRM sync (non-blocking)
    syncCRM(agent, phone, contactName, savedContent).catch((e) => logger.error("Webhook", "CRM sync error", { error: e.message }));

    // Check automation flows
    const messageText = (savedContent || "").toLowerCase().trim();
    const { data: allActiveFlows } = await supabase
      .from("automation_flows")
      .select("id, name, trigger_type, trigger_value, follow_up_enabled, follow_up_flow_id, follow_up_mode, follow_up_keywords")
      .eq("agent_id", agent.id)
      .eq("is_active", true)
      .in("trigger_type", ["keyword", "first_message"]);

    const keywordFlows = (allActiveFlows || []).filter((f) => f.trigger_type === "keyword");
    const firstMsgFlows = (allActiveFlows || []).filter((f) => f.trigger_type === "first_message");

    let matchedFlow = null;

    for (const flow of keywordFlows) {
      const keywords = flow.trigger_value.toLowerCase().split(",").map((k) => k.trim());
      if (keywords.some((kw) => messageText.includes(kw))) {
        matchedFlow = flow;
        break;
      }
    }

    if (!matchedFlow && firstMsgFlows.length > 0) {
      const { count } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversation.id);
      if (count && count <= 1) matchedFlow = firstMsgFlows[0];
    }

    // Execute automation
    if (matchedFlow) {
      const { data: flowNodes } = await supabase
        .from("automation_nodes")
        .select("*")
        .eq("flow_id", matchedFlow.id)
        .order("sort_order", { ascending: true });

      if (flowNodes?.length) {
        const { data: execData } = await supabase.from("automation_executions").insert({
          flow_id: matchedFlow.id, contact_phone: phone, status: "running",
        }).select("id").single();

        await executeFlowNodes(agent, phone, flowNodes, conversation.id);

        if (execData?.id) {
          await supabase.from("automation_executions").update({
            status: "completed", completed_at: new Date().toISOString(),
          }).eq("id", execData.id);
        }

        // Schedule follow-ups
        try {
          const { data: followUps } = await supabase
            .from("automation_follow_ups")
            .select("*")
            .eq("flow_id", matchedFlow.id)
            .eq("is_active", true)
            .order("sort_order", { ascending: true });

          if (followUps?.length) {
            await supabase.from("follow_up_queue")
              .update({ status: "cancelled", cancelled_reason: "new_flow_triggered" })
              .eq("agent_id", agent.id).eq("contact_phone", phone).eq("flow_id", matchedFlow.id).eq("status", "pending");

            const firstFU = followUps[0];
            await supabase.from("follow_up_queue").insert({
              follow_up_id: firstFU.id,
              flow_id: matchedFlow.id,
              follow_up_flow_id: firstFU.follow_up_flow_id,
              agent_id: agent.id,
              contact_phone: phone,
              fire_at: new Date(Date.now() + firstFU.delay_minutes * 60 * 1000).toISOString(),
            });
          }
        } catch (fuErr) {
          logger.error("Webhook", "Follow-up scheduling error", { error: fuErr.message });
        }

        await logger.info("Webhook", `Automation executed: ${matchedFlow.name}`, { phone, flow: matchedFlow.id });
        return res.json({ status: "automation_executed", flow: matchedFlow.name });
      }
    }

    // AI disabled check
    if (conversation.ai_disabled) return res.json({ status: "ai_disabled_skip" });
    if (agent.ai_enabled === false) return res.json({ status: "ai_disabled" });

    // Check active automation (skip AI)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: activeAutomation } = await supabase
      .from("automation_executions")
      .select("id, status, started_at, flow_id")
      .eq("contact_phone", phone)
      .gte("started_at", thirtyMinAgo)
      .in("status", ["running", "completed"])
      .order("started_at", { ascending: false })
      .limit(1);

    if (activeAutomation?.length) {
      const exec = activeAutomation[0];
      const aiAfterFlow = agent.activate_ai_after_flow === true;
      if (!(exec.status === "completed" && aiAfterFlow)) {
        return res.json({ status: "automation_active_skip_ai" });
      }
    }

    // AI Lock via Redis
    const gotLock = await tryAcquireAILock(agent.id, phone);
    if (!gotLock) return res.json({ status: "ai_locked_skip" });

    try {
      const { apiKey, apiKeyId, availableKeys, userSub } = await getApiKeyForModel(agent.ai_model, agent.user_id, agent);

      if (!apiKey) {
        return res.status(500).json({ error: "api_key_not_configured" });
      }

      // Check monthly usage limit
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const { data: usageData } = await supabase
        .from("ai_usage_logs")
        .select("cost_usd")
        .eq("user_id", agent.user_id)
        .gte("created_at", monthStart.toISOString());

      const currentMonthCostUsd = (usageData || []).reduce((sum, r) => sum + parseFloat(r.cost_usd || 0), 0);
      const aiMonthlyLimitUsd = parseFloat(userSub?.ai_monthly_limit_usd || "5.00");

      if (currentMonthCostUsd >= aiMonthlyLimitUsd) {
        await sendTextMessage(agent, phone, "No momento não consigo responder automaticamente. Por favor, aguarde o atendimento humano. 🙏");
        return res.json({ ok: true, blocked: "ai_limit_exceeded" });
      }

      // Get chat history + knowledge + training + media
      const [
        { data: recentMessages },
        { data: knowledge },
        { data: trainingData },
        { data: agentMediaItems },
      ] = await Promise.all([
        supabase.from("messages").select("direction, content").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(20),
        supabase.from("knowledge_base").select("title, content, category").eq("agent_id", agent.id),
        supabase.from("agent_training").select("type, content, context").eq("agent_id", agent.id).order("created_at", { ascending: true }),
        supabase.from("agent_media").select("id, type, label, trigger_keyword, file_url, pix_key").eq("agent_id", agent.id),
      ]);

      const chatHistory = (recentMessages || []).reverse().map((m) => ({
        role: m.direction === "incoming" ? "user" : "assistant",
        content: m.content,
      }));

      const knowledgeContext = (knowledge || []).map((k) => `[${k.category}] ${k.title}: ${k.content}`).join("\n\n");

      // Build training instructions
      let trainingInstructions = "";
      if (trainingData?.length) {
        const instructions = trainingData.filter((t) => t.type === "instruction").map((t) => `- ${t.content}`);
        const corrections = trainingData.filter((t) => t.type === "correction").map((t) => `- ${t.content}`);
        const styles = trainingData.filter((t) => t.type === "style").map((t) => `- ${t.content}`);
        const forbidden = trainingData.filter((t) => t.type === "forbidden").map((t) => `- ${t.content}`);
        const sections = [];
        if (instructions.length) sections.push(`INSTRUÇÕES DO DONO:\n${instructions.join("\n")}`);
        if (corrections.length) sections.push(`CORREÇÕES APRENDIDAS:\n${corrections.join("\n")}`);
        if (styles.length) sections.push(`ESTILO OBRIGATÓRIO:\n${styles.join("\n")}`);
        if (forbidden.length) sections.push(`NUNCA FAÇA ISSO:\n${forbidden.join("\n")}`);
        trainingInstructions = "\n\nTREINAMENTO PERSONALIZADO (PRIORIDADE MÁXIMA):\n" + sections.join("\n\n");
      }

      // Media library
      let mediaLibraryInstructions = "";
      if (agentMediaItems?.length) {
        const mediaList = agentMediaItems.map((m) => {
          const trigger = m.trigger_keyword ? ` (enviar quando: "${m.trigger_keyword}")` : "";
          if (m.type === "audio") return `- [ENVIAR_AUDIO:${m.id}] Áudio: "${m.label}"${trigger}`;
          if (m.type === "image") return `- [ENVIAR_IMAGEM:${m.id}] Imagem: "${m.label}"${trigger}`;
          if (m.type === "pix") return `- [ENVIAR_PIX:${m.id}] Chave PIX: "${m.label}" (${m.pix_key})${trigger}`;
          if (m.type === "document") return `- [ENVIAR_DOCUMENTO:${m.id}] Documento: "${m.label}"${trigger}`;
          return "";
        }).filter(Boolean).join("\n");

        mediaLibraryInstructions = `\n\nBIBLIOTECA DE MÍDIAS DISPONÍVEIS:\n${mediaList}\n\nREGRAS: Use tags [ENVIAR_*:uuid] separadas por "|||".`;
      }

      const useCaseDescriptions = {
        vendas: "Especialista em vendas.",
        suporte: "Suporte técnico.",
        agendamento: "Agendamento de compromissos.",
        qualificacao: "Qualificação de leads.",
        "pos-venda": "Pós-venda e fidelização.",
        cobranca: "Cobranças educadas.",
      };
      const useCaseInstructions = (agent.use_cases || []).map((uc) => useCaseDescriptions[uc] || "").filter(Boolean).join("\n");

      const systemPrompt = `${agent.personality}\n\n${agent.system_prompt}\n\n${useCaseInstructions ? "CASOS DE USO:\n" + useCaseInstructions : ""}\n\n${knowledgeContext ? "BASE DE CONHECIMENTO:\n" + knowledgeContext : ""}${mediaLibraryInstructions}${trainingInstructions}\n\nREGRAS: Divida respostas em blocos curtos com "|||". Máximo 20 palavras por bloco. Use linguagem informal BR. Nunca diga que é IA.\nNome do contato: ${contactName}`;

      let effectiveModel = agent.ai_model;
      let effectiveApiKey = apiKey;

      if (msgData.type === "image" && imageBase64 && cachedOpenaiKey) {
        effectiveModel = "openai-gpt4o";
        effectiveApiKey = cachedOpenaiKey;
      }

      const currentContent = {
        type: msgData.type,
        text: msgData.text,
        imageBase64: imageBase64 || undefined,
        imageMimetype: msgData.imageMimetype,
        imageCaption: msgData.imageCaption,
        transcribedAudio,
      };

      const aiMessages = buildAIMessages(systemPrompt, chatHistory, currentContent, effectiveModel);

      const stopAiPresence = startPresenceHeartbeat(agent, phone, "composing");

      let result;
      try {
        result = await callAI(effectiveApiKey, effectiveModel, systemPrompt, aiMessages, currentContent);

        // Rate limit rotation
        if (result.isRateLimited && apiKeyId && availableKeys && availableKeys.length > 1) {
          const cooldown = new Date(Date.now() + 60000).toISOString();
          await supabase.from("api_keys").update({ last_rate_limited_at: new Date().toISOString(), cooldown_until: cooldown }).eq("id", apiKeyId);
          for (let i = 1; i < availableKeys.length; i++) {
            result = await callAI(availableKeys[i].api_key, agent.ai_model, systemPrompt, aiMessages, currentContent);
            if (!result.isRateLimited) break;
          }
        }
      } finally {
        stopAiPresence();
      }

      // Log usage
      const inputTokens = result.inputTokens || 0;
      const outputTokens = result.outputTokens || 0;
      const costUsd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
      await supabase.from("ai_usage_logs").insert({
        agent_id: agent.id, user_id: agent.user_id,
        input_tokens: inputTokens, output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens, cost_usd: costUsd, model: agent.ai_model,
      }).catch(() => {});

      const aiResponse = result.response || "Desculpa, não entendi. Pode repetir?";

      // Split into chunks
      let rawChunks = aiResponse.split("|||").map((c) => c.trim()).filter(Boolean);
      if (!rawChunks.length) rawChunks = [aiResponse];

      const chunks = [];
      for (const rc of rawChunks) {
        if (rc.length <= 80) { chunks.push(rc); continue; }
        const sentences = rc.split(/(?<=[.!?…])\s+/).filter(Boolean);
        for (const s of sentences) {
          if (s.length <= 100) { chunks.push(s); continue; }
          const parts = s.split(/,\s*/).filter(Boolean);
          let current = "";
          for (const p of parts) {
            if (current && (current + ", " + p).length > 80) { chunks.push(current); current = p; }
            else current = current ? current + ", " + p : p;
          }
          if (current) chunks.push(current);
        }
      }

      // Save AI response to Supabase
      await supabase.from("messages").insert({
        conversation_id: conversation.id, direction: "outgoing", content: chunks.join("\n"),
      });

      // Log outgoing to local PG
      await query(
        "INSERT INTO messages (agent_id, phone, direction, content, processed) VALUES ($1, $2, $3, $4, $5)",
        [agent.id, phone, "outgoing", chunks.join("\n"), true]
      ).catch(() => {});

      // Media map for tags
      const mediaMap = new Map();
      if (agentMediaItems) for (const m of agentMediaItems) mediaMap.set(m.id, m);

      // Send chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const mediaTagMatch = chunk.match(/\[ENVIAR_(AUDIO|IMAGEM|PIX|DOCUMENTO):([^\]]+)\]/);
        if (mediaTagMatch) {
          const mediaItem = mediaMap.get(mediaTagMatch[2]);
          if (mediaItem) {
            const remainingText = chunk.replace(/\[ENVIAR_\w+:[^\]]+\]/g, "").trim();
            if (remainingText) {
              await waitWithPresence(agent, phone, "composing", estimateTypingDelayMs(remainingText));
              await sendTextMessage(agent, phone, remainingText);
            }
            if (mediaItem.type === "audio" && mediaItem.file_url) await sendAudioFileMessage(agent, phone, mediaItem.file_url);
            else if (mediaItem.type === "image" && mediaItem.file_url) await sendImageMessage(agent, phone, mediaItem.file_url, mediaItem.label);
            else if (mediaItem.type === "document" && mediaItem.file_url) await sendDocumentMessage(agent, phone, mediaItem.file_url, mediaItem.label);
            else if (mediaItem.type === "pix" && mediaItem.pix_key) await sendTextMessage(agent, phone, `💰 *Chave PIX:*\n\n\`${mediaItem.pix_key}\`\n\n_${mediaItem.label}_`);
          }
          continue;
        }

        const autoDelayMs = estimateTypingDelayMs(chunk);
        const responseBaseDelayMs = i === 0 ? Math.max(agent.response_delay_ms || 0, autoDelayMs) : autoDelayMs;
        await waitWithPresence(agent, phone, "composing", responseBaseDelayMs);
        await sendTextMessage(agent, phone, chunk);
      }

      await logger.info("Webhook", "AI response sent", { phone, model: agent.ai_model, chunks: chunks.length });
      return res.json({ status: "ok", type: msgData.type });
    } finally {
      await releaseAILock(agent.id, phone);
    }
  } catch (error) {
    webhookCircuit.recordFailure();
    await logger.error("Webhook", "Webhook error", { error: error.message });
    return res.status(500).json({ error: "Internal server error" });
  }
}

// CRM sync helper
async function syncCRM(agent, phone, contactName, savedContent) {
  const { data: crmStages } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("agent_id", agent.id)
    .order("sort_order", { ascending: true });

  if (!crmStages?.length) return;

  const { data: existingContact } = await supabase
    .from("crm_contacts")
    .select("id, stage_id, labels")
    .eq("agent_id", agent.id)
    .eq("contact_phone", phone)
    .maybeSingle();

  if (existingContact) {
    if (contactName !== phone) {
      await supabase.from("crm_contacts").update({ contact_name: contactName }).eq("id", existingContact.id);
    }
  } else {
    const firstStage = crmStages[0];
    const { count } = await supabase
      .from("crm_contacts")
      .select("id", { count: "exact", head: true })
      .eq("stage_id", firstStage.id);

    await supabase.from("crm_contacts").insert({
      agent_id: agent.id,
      stage_id: firstStage.id,
      contact_phone: phone,
      contact_name: contactName !== phone ? contactName : null,
      position: count || 0,
    });
  }
}

module.exports = { webhookController };
