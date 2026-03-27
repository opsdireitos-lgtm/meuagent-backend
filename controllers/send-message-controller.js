const { supabase } = require("../config/supabase");
const {
  sendTextMessage, sendImageMessage, sendAudioFileMessage,
  sendDocumentMessage, sendVideoMessage,
} = require("../services/evolution-api");
const logger = require("../services/logger");

async function sendMessageController(req, res) {
  try {
    const { instance, number, message, media_type, media_url, caption } = req.body;

    if (!instance || !number) {
      return res.status(400).json({ error: "instance e number são obrigatórios" });
    }

    // Find agent by instance name
    const { data: agent } = await supabase
      .from("agents")
      .select("id, evolution_api_url, evolution_api_key, evolution_instance")
      .eq("evolution_instance", instance)
      .single();

    if (!agent?.evolution_api_url) {
      return res.status(400).json({ error: "Instância não encontrada ou sem conexão WhatsApp" });
    }

    const cleanPhone = number.replace(/\D/g, "");
    const type = media_type || "text";
    let success = false;

    if (type === "text") {
      success = await sendTextMessage(agent, cleanPhone, message || "");
    } else if (type === "image" && media_url) {
      success = await sendImageMessage(agent, cleanPhone, media_url, caption || message);
    } else if (type === "audio" && media_url) {
      success = await sendAudioFileMessage(agent, cleanPhone, media_url);
    } else if (type === "document" && media_url) {
      success = await sendDocumentMessage(agent, cleanPhone, media_url, caption || "documento");
    } else if (type === "video" && media_url) {
      success = await sendVideoMessage(agent, cleanPhone, media_url, caption || "");
    } else {
      success = await sendTextMessage(agent, cleanPhone, message || "");
    }

    await logger.info("SendMessage", `Message sent to ${cleanPhone}`, { type, success });
    return res.json({ status: success ? "sent" : "failed" });
  } catch (e) {
    await logger.error("SendMessage", "Send message error", { error: e.message });
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { sendMessageController };
