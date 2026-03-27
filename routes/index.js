const { webhookController } = require("../controllers/webhook-controller");
const { healthController } = require("../controllers/health-controller");

function registerRoutes(app) {
  // Health check
  app.get("/health", healthController);

  // WhatsApp Webhook
  app.post("/webhook", webhookController);

  // Send message
  app.post("/message/send", require("../controllers/send-message-controller").sendMessageController);

  // Execute automation flow
  app.post("/execute-flow", require("../controllers/execute-flow-controller").executeFlowController);
}

module.exports = { registerRoutes };
