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
const OUTRA_SESSAO = "dddddddd-0000-4000-8000-000000000002";
const GRUPO = "120363000000000001@g.us";
const GRUPO_DA_OUTRA = "120363000000000099@g.us";

// Snapshot dos contatos que JÁ existiam antes deste arquivo mexer no banco
// (seed do gov-helpers). Escopar o teste de vocabulário a estes ids — em vez
// de `select count(*) from contacts` sem filtro — evita que ele dependa da
// ordem dos `describe`s deste arquivo (mais abaixo, este mesmo arquivo insere
// contato `kind='whatsapp_group'` de propósito) ou de seed futura que também
// crie contato de grupo.
let idsPreExistentes: string[] = [];

beforeAll(async () => {
  await seedGov();
  idsPreExistentes = (await q("select id from contacts")).rows.map((r) => r.id as string);
  await q(
    "insert into organizations(id,legal_name,display_name,slug) values($1,'Outra','Outra','outra-grupos') on conflict do nothing",
    [OUTRA_ORG],
  );
  // Sessão + linha de channel_session_groups da OUTRA organização, gravadas
  // como superusuário (bypassa RLS de propósito — é o setup, não a prova).
  // Sem esta linha, a asserção de isolamento cross-org do teste abaixo é
  // vazia: `count(*) = 0` é garantido com ou sem RLS quando não existe linha
  // nenhuma da outra organização para vazar.
  await q(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'outra-grupos-session','WORKING',decode('00','hex')) on conflict do nothing",
    [OUTRA_SESSAO, OUTRA_ORG],
  );
  await q(
    "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id,subject) values($1,$2,$3,'Grupo da Outra Org')",
    [OUTRA_ORG, OUTRA_SESSAO, GRUPO_DA_OUTRA],
  );
});
afterAll(() => pool.end());

describe("contacts.kind", () => {
  it("contatos pré-existentes (seed) nascem 'person'; valor fora do vocabulário é recusado", async () => {
    const r = await q("select count(*)::int n from contacts where id = any($1) and kind <> 'person'", [idsPreExistentes]);
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
    ).rejects.toThrow(/row-level security/i);

    // Controle de não-vacuidade: a linha da OUTRA_ORG existe de verdade (foi
    // semeada em beforeAll como superusuário) — se este count desse 0 também,
    // a prova de isolamento logo abaixo estaria medindo o nada.
    const existeMesmo = await q("select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(existeMesmo.rows[0].n).toBe(1);

    // A prova de isolamento em si: o gerente de `org`, autenticado, não
    // enxerga a linha real da OUTRA_ORG.
    const daOutra = await comoUsuario(manager, "select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(daOutra.rows[0].n).toBe(0);

    // RLS bloqueia escrita cross-org também, não só leitura: o gerente de
    // `org` não apaga nem altera a linha da OUTRA_ORG (0 linhas afetadas,
    // nunca erro — a policy filtra, não lança).
    const apagouDaOutra = await comoUsuario(manager, "delete from channel_session_groups where organization_id=$1 returning id", [OUTRA_ORG]);
    expect(apagouDaOutra.rowCount).toBe(0);
    const aindaExiste = await q("select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(aindaExiste.rows[0].n).toBe(1);

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
