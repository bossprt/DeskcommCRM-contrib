import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_MANAGER as manager,
  GOV_AGENT_A as agente,
  GOV_SESSION as sessao,
} from "./gov-helpers";

const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 4 });
const q = (t: string, a: unknown[] = []) => pool.query(t, a);
async function comoUsuario(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const r = await c.query(text, args); await c.query("commit"); return r;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000001";
const GRUPO = "120363000000000001@g.us";

beforeAll(async () => {
  await seedGov();
  await q(
    "insert into organizations(id,legal_name,display_name,slug) values($1,'Outra','Outra','outra-grupos') on conflict do nothing",
    [OUTRA_ORG],
  );
});
afterAll(() => pool.end());

describe("contacts.kind", () => {
  it("contato existente e novo nascem 'person'; valor fora do vocabulário é recusado", async () => {
    const r = await q("select count(*)::int n from contacts where kind <> 'person'");
    expect(r.rows[0].n).toBe(0);
    await expect(q("update contacts set kind='outro' where organization_id=$1", [org])).rejects.toThrow(/check/i);
  });
});

describe("channel_session_groups", () => {
  it("isola por organização (RLS) e só gerente escreve", async () => {
    await q("delete from channel_session_groups where organization_id=$1", [org]);
    await comoUsuario(manager, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id,subject) values($1,$2,$3,'Teste')", [org, sessao, GRUPO]);
    await expect(
      comoUsuario(agente, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id) values($1,$2,'x@g.us')", [org, sessao]),
    ).rejects.toThrow();
    const daOutra = await comoUsuario(manager, "select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(daOutra.rows[0].n).toBe(0);
    const doAgente = await comoUsuario(agente, "select count(*)::int n from channel_session_groups where organization_id=$1", [org]);
    expect(doAgente.rows[0].n).toBe(1);
  });
});

describe("conversa de grupo no banco", () => {
  async function conversaDeGrupo() {
    const c = await q(
      "insert into contacts(organization_id,name,display_name,kind,source) values($1,'Grupo Teste','Grupo Teste','whatsapp_group','whatsapp_group') returning id",
      [org],
    );
    const conv = await q(
      "insert into conversations(organization_id,contact_id,channel_session_id,channel,status,is_group,group_chat_id) values($1,$2,$3,'whatsapp','open',true,$4) returning id",
      [org, c.rows[0].id, sessao, GRUPO],
    );
    return { contato: c.rows[0].id as string, conversa: conv.rows[0].id as string };
  }

  it("conversa de grupo nova NÃO pede roteamento", async () => {
    const { conversa } = await conversaDeGrupo();
    const r = await q("select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'", [org, conversa]);
    expect(r.rows[0].n).toBe(0);
  });

  it("mensagem recebida em grupo emite message.group_received e nunca message.received", async () => {
    const { contato, conversa } = await conversaDeGrupo();
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conversa, sessao, contato, `grp-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    const nomes = tipos.rows.map((r) => r.event_type);
    expect(nomes).toContain("message.group_received");
    expect(nomes).not.toContain("message.received");
  });

  it("conversa individual continua emitindo message.received (controle)", async () => {
    const conv = await q("select id, contact_id from conversations where organization_id=$1 and is_group=false limit 1", [org]);
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conv.rows[0].id, sessao, conv.rows[0].contact_id, `ind-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    expect(tipos.rows.map((r) => r.event_type)).toContain("message.received");
  });
});

describe("uq_contacts_grupo", () => {
  it("um segundo contato de grupo com o mesmo group_chat_id na mesma organização é recusado", async () => {
    await q(
      "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Dup','Grupo Dup','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text))",
      [org, GRUPO],
    );
    await expect(
      q(
        "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Dup 2','Grupo Dup 2','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text))",
        [org, GRUPO],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
