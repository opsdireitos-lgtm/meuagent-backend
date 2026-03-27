// ══════════════════════════════════════════════
// Evolution API - Full Integration
// ══════════════════════════════════════════════

function headers(apikey) {
  return { "Content-Type": "application/json", apikey };
}

async function sendTextMessage(agent, phone, text) {
  const url = `${agent.evolution_api_url}/message/sendText/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, text }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send text:", await res.text());
  return res.ok;
}

async function sendImageMessage(agent, phone, imageUrl, caption) {
  const url = `${agent.evolution_api_url}/message/sendMedia/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, mediatype: "image", media: imageUrl, caption: caption || "" }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send image:", await res.text());
  return res.ok;
}

async function sendAudioFileMessage(agent, phone, audioUrl) {
  const url = `${agent.evolution_api_url}/message/sendWhatsAppAudio/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, audio: audioUrl }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send audio:", await res.text());
  return res.ok;
}

async function sendDocumentMessage(agent, phone, documentUrl, fileName) {
  const url = `${agent.evolution_api_url}/message/sendMedia/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, mediatype: "document", media: documentUrl, fileName: fileName || "documento.pdf" }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send document:", await res.text());
  return res.ok;
}

async function sendVideoMessage(agent, phone, videoUrl, caption) {
  const url = `${agent.evolution_api_url}/message/sendMedia/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, mediatype: "video", media: videoUrl, caption: caption || "" }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send video:", await res.text());
  return res.ok;
}

async function sendStickerMessage(agent, phone, stickerUrl) {
  const url = `${agent.evolution_api_url}/message/sendSticker/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, sticker: stickerUrl }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send sticker:", await res.text());
  return res.ok;
}

async function sendContactMessage(agent, phone, contactName, contactPhone) {
  const url = `${agent.evolution_api_url}/message/sendContact/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({
      number: phone,
      contact: [{ fullName: contactName, wuid: contactPhone, phoneNumber: contactPhone }],
    }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send contact:", await res.text());
  return res.ok;
}

async function sendLocationMessage(agent, phone, lat, lng, name) {
  const url = `${agent.evolution_api_url}/message/sendLocation/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({ number: phone, latitude: lat, longitude: lng, name: name || "Localização" }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send location:", await res.text());
  return res.ok;
}

async function sendButtonsMessage(agent, phone, bodyText, buttons) {
  const url = `${agent.evolution_api_url}/message/sendButtons/${agent.evolution_instance}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(agent.evolution_api_key),
    body: JSON.stringify({
      number: phone,
      title: "",
      description: bodyText,
      buttons: buttons.slice(0, 3).map((b, i) => ({ buttonId: `btn_${i}`, buttonText: { displayText: b.trim() } })),
    }),
  });
  if (!res.ok) console.error("[EvoAPI] Failed to send buttons:", await res.text());
  return res.ok;
}

async function sendPresence(agent, phone, presence, delayMs = 4000) {
  const safeDelay = Math.max(1000, Math.min(120000, Math.round(delayMs)));
  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
  const bareNumber = phone.replace(/@.*/, "");

  const attempts = [
    { body: { number: jid, presence, delay: safeDelay } },
    { body: { number: bareNumber, presence, delay: safeDelay } },
  ];

  const url = `${agent.evolution_api_url}/chat/sendPresence/${agent.evolution_instance}`;
  for (const attempt of attempts) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(agent.evolution_api_key),
        body: JSON.stringify(attempt.body),
      });
      if (res.ok) return;
    } catch { /* ignore */ }
  }
}

async function fetchMediaBase64(agent, message) {
  try {
    const res = await fetch(
      `${agent.evolution_api_url}/chat/getBase64FromMediaMessage/${agent.evolution_instance}`,
      {
        method: "POST",
        headers: headers(agent.evolution_api_key),
        body: JSON.stringify({ message: { key: message.key } }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.base64 || null;
  } catch {
    return null;
  }
}

module.exports = {
  sendTextMessage, sendImageMessage, sendAudioFileMessage,
  sendDocumentMessage, sendVideoMessage, sendStickerMessage,
  sendContactMessage, sendLocationMessage, sendButtonsMessage,
  sendPresence, fetchMediaBase64,
};
