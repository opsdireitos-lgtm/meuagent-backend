const { supabase } = require("../config/supabase");
const { executeFlowNodes } = require("../services/automation-executor");
const logger = require("../services/logger");

async function executeFlowController(req, res) {
  try {
    const { user_id, flow_id, phone } = req.body;

    if (!user_id || !flow_id || !phone) {
      return res.status(400).json({ error: "user_id, flow_id e phone são obrigatórios" });
    }

    // Verify user owns the flow
    const { data: flow } = await supabase
      .from("automation_flows")
      .select("id, name, agent_id")
      .eq("id", flow_id)
      .single();

    if (!flow) {
      return res.status(404).json({ error: "Fluxo não encontrado" });
    }

    // Get agent
    const { data: agent } = await supabase
      .from("agents")
      .select("*")
      .eq("id", flow.agent_id)
      .eq("user_id", user_id)
      .single();

    if (!agent) {
      return res.status(403).json({ error: "Agente não pertence ao usuário ou não encontrado" });
    }

    // Get flow nodes
    const { data: flowNodes } = await supabase
      .from("automation_nodes")
      .select("*")
      .eq("flow_id", flow_id)
      .order("sort_order", { ascending: true });

    if (!flowNodes?.length) {
      return res.status(400).json({ error: "Fluxo sem nós configurados" });
    }

    const cleanPhone = phone.replace(/\D/g, "");

    // Create execution record
    const { data: execData } = await supabase.from("automation_executions").insert({
      flow_id, contact_phone: cleanPhone, status: "running",
    }).select("id").single();

    // Find or create conversation
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("agent_id", agent.id)
      .eq("contact_phone", cleanPhone)
      .eq("is_active", true)
      .maybeSingle();

    // Execute flow
    await executeFlowNodes(agent, cleanPhone, flowNodes, conversation?.id || null);

    // Mark completed
    if (execData?.id) {
      await supabase.from("automation_executions").update({
        status: "completed", completed_at: new Date().toISOString(),
      }).eq("id", execData.id);
    }

    await logger.info("ExecuteFlow", `Flow executed: ${flow.name}`, { phone: cleanPhone, flow_id });
    return res.json({ status: "executed", flow: flow.name, execution_id: execData?.id });
  } catch (e) {
    await logger.error("ExecuteFlow", "Execute flow error", { error: e.message });
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { executeFlowController };
