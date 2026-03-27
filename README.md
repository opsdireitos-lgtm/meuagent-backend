# MeuAgent VPS Backend

Backend Node.js para rodar na VPS com Evolution API, substituindo as Edge Functions pesadas do Supabase.

## Arquitetura

```
┌────────────────────┐     ┌─────────────┐     ┌──────────────┐
│  Evolution API     │────▶│  VPS Backend │────▶│   Supabase   │
│  (WhatsApp)        │     │  (Express)   │     │  (Database)  │
└────────────────────┘     └──────┬───────┘     └──────────────┘
                                  │
                           ┌──────┴───────┐
                           │    Redis     │
                           │  (Filas)     │
                           └──────────────┘
```

## Componentes

| Componente | Substitui | Função |
|---|---|---|
| `routes/webhook.ts` | `whatsapp-webhook` | Processa mensagens recebidas, AI, automações |
| `workers/follow-up-worker.ts` | `follow-up-processor` | Processa fila de follow-ups agendados |
| `workers/bulk-worker.ts` | `bulk-scheduler` + `bulk-send` | Envia campanhas em massa |
| `routes/send-message.ts` | - | Endpoint para envio de mensagens avulso |
| `lib/evolution-api.ts` | - | Helpers para Evolution API |
| `lib/circuit-breaker.ts` | - | Proteção contra sobrecarga |

## Setup

### 1. Clone e configure

```bash
cp .env.example .env
# Edite o .env com suas credenciais
```

### 2. Deploy com Docker (Portainer)

```bash
docker-compose up -d
```

### 3. Configure o webhook na Evolution API

Aponte o webhook de todas as instâncias para:
```
http://SEU_IP_VPS:3333/webhook/whatsapp
```

### 4. Redis

O Redis é usado para:
- **Deduplicação** de mensagens (TTL 2 min)
- **Lock de AI** por telefone (evita respostas duplicadas)
- Filas BullMQ (preparado para uso futuro)

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Status do servidor + circuit breakers |
| POST | `/webhook/whatsapp` | Webhook da Evolution API |
| POST | `/api/send-message` | Envio avulso de mensagens |

## Workers (Background)

- **Follow-up Worker**: Roda a cada 30s, processa follow-ups pendentes
- **Bulk Worker**: Roda a cada 60s, processa campanhas em massa

## Migração

Após o deploy, atualize o webhook da Evolution API:

**Antes (Supabase):**
```
https://cwkeaewvnirvmkuodsjx.supabase.co/functions/v1/whatsapp-webhook
```

**Depois (VPS):**
```
http://SEU_IP:3333/webhook/whatsapp
```

O `bulk-scheduler` e `follow-up-processor` do Supabase podem ser desativados pois os workers do backend já fazem o mesmo trabalho.

## Monitoramento

```bash
# Logs em tempo real
docker-compose logs -f backend

# Health check
curl http://localhost:3333/health
```
