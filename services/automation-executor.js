const { supabase } = require("../config/supabase");
const {
  sendTextMessage, sendImageMessage, sendAudioFileMessage,
  sendVideoMessage, sendDocumentMessage, sendStickerMessage,
  sendContactMessage, sendLocationMessage, sendButtonsMessage,
} = require("./evolution-api");
const { waitWithPresence, estimateTypingDelayMs, runWithPresence, clamp, sleep } = require("./presence");

function estimateAudioDurationFromSizeMs(byteLength) {
  return Math.round((byteLength * 8 * 1000) / 24000);
}

async function estimateRemoteAudioDurationMs(audioUrl) {
  try {
    const response = await fetch(audioUrl);
    if (!response.ok) return 4000;
    const bytes = await response.arrayBuffer();
    return clamp(estimateAudioDurationFromSizeMs(bytes.byteLength), 2000, 120000);
  } catch {
    return 4000;
  }
}

function estimateAudioSendTailMs(referenceMs) {
  return clamp(3000 + Math.round(referenceMs * 0.12), 3000, 12000);
}

async function executeFlowNodes(agent, phone, flowNodes, conversationId) {
  const nodeMap = new Map();
  flowNodes.forEach((n) => nodeMap.set(n.id, n));
  const referencedIds = new Set(flowNodes.map((n) => n.next_node_id).filter(Boolean));
  const startNode = flowNodes.find((n) => !referencedIds.has(n.id)) || flowNodes[0];

  const orderedNodes = [];
  const visited = new Set();
  let current = startNode;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    orderedNodes.push(current);
    current = current.next_node_id ? nodeMap.get(current.next_node_id) : null;
  }
  if (orderedNodes.length === 0) orderedNodes.push(...flowNodes);

  for (const node of orderedNodes) {
    const delaySec = node.node_type === "delay" ? (parseInt(node.content) || node.delay_seconds) : node.delay_seconds;
    const configuredDelayMs = Math.max(0, (delaySec || 0) * 1000);

    if (node.node_type === "delay") {
      await sleep(configuredDelayMs);
      continue;
    }

    if (node.node_type === "audio" && node.file_url) {
      const audioLeadTimeMs = configuredDelayMs || await estimateRemoteAudioDurationMs(node.file_url);
      const audioTailMs = estimateAudioSendTailMs(audioLeadTimeMs);
      await runWithPresence(agent, phone, "recording", audioLeadTimeMs, async () => {
        await sendAudioFileMessage(agent, phone, node.file_url);
      }, audioTailMs);

      if (conversationId) {
        await supabase.from("messages").insert({
          conversation_id: conversationId,
          direction: "outgoing",
          content: `[audio] ${node.content || "arquivo"}`,
        });
      }
      continue;
    }

    let leadTimeMs = configuredDelayMs;
    if (leadTimeMs === 0) {
      if (node.node_type === "text" && node.content) {
        leadTimeMs = estimateTypingDelayMs(node.content);
      } else {
        leadTimeMs = 1200;
      }
    }

    if (leadTimeMs > 0) {
      await waitWithPresence(agent, phone, "composing", leadTimeMs);
    }

    if (node.node_type === "text" && node.content) {
      await sendTextMessage(agent, phone, node.content);
    } else if (node.node_type === "image" && node.file_url) {
      await sendImageMessage(agent, phone, node.file_url, node.content || "");
    } else if (node.node_type === "video" && node.file_url) {
      await sendVideoMessage(agent, phone, node.file_url, node.content || "");
    } else if (node.node_type === "document" && node.file_url) {
      await sendDocumentMessage(agent, phone, node.file_url, node.content || "documento.pdf");
    } else if (node.node_type === "sticker" && node.file_url) {
      await sendStickerMessage(agent, phone, node.file_url);
    } else if (node.node_type === "contact") {
      const contactPhone = node.file_url || "";
      if (contactPhone) await sendContactMessage(agent, phone, node.content || "Contato", contactPhone);
    } else if (node.node_type === "location") {
      const coords = (node.file_url || "").split(",");
      const lat = parseFloat(coords[0]) || 0;
      const lng = parseFloat(coords[1]) || 0;
      if (lat !== 0 || lng !== 0) await sendLocationMessage(agent, phone, lat, lng, node.content || "");
    } else if (node.node_type === "buttons" && node.content) {
      const parts = node.content.split("---");
      const bodyText = (parts[0] || "").trim();
      const buttonsText = (parts[1] || "").trim().split("\n").filter(Boolean);
      if (buttonsText.length > 0) await sendButtonsMessage(agent, phone, bodyText, buttonsText);
      else await sendTextMessage(agent, phone, bodyText);
    } else if (node.node_type === "transfer") {
      if (node.content) await sendTextMessage(agent, phone, node.content);
      if (conversationId) {
        await supabase.from("messages").insert({
          conversation_id: conversationId,
          direction: "outgoing",
          content: node.content || "[Transferido para atendimento humano]",
        });
      }
      break;
    }

    if (conversationId && node.node_type !== "delay" && node.node_type !== "transfer") {
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        direction: "outgoing",
        content: node.node_type === "text" ? node.content : `[${node.node_type}] ${node.content || "arquivo"}`,
      });
    }
  }
}

module.exports = { executeFlowNodes };
