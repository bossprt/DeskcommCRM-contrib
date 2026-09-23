/**
 * Grupos de WhatsApp na inbox: qual grupo de cada número entra no CRM.
 * Spec: docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md
 *
 * O filtro do WhatsApp é tudo ou nada por número: ligar o PRIMEIRO grupo passa a receber
 * todos (e a entrada descarta os não escolhidos); desligar o ÚLTIMO volta a ignorar. A troca
 * do filtro precisa ser CONFIRMADA antes de gravar "ligado": nunca fica ligado sem estar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit as auditReal } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { capabilitiesOf, getAdapter } from "@/lib/channels";
import { resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type { ChannelGroup, ChannelProvider } from "@/lib/channels/types";

export class GrupoError extends Error {
  constructor(public readonly code: "sessao_nao_encontrada" | "canal_sem_grupos" | "filtro_nao_confirmado") {
    super(code);
    this.name = "GrupoError";
  }
}

// Aceita o formato atual (`<digitos>@g.us`) e o legado medido no servidor real
// (`<digitos>-<digitos>@g.us`) — a régua não é a forma nova, é a que o WhatsApp
// de verdade envia hoje.
const chatIdDeGrupo = z.string().regex(/^[\d-]+@g\.us$/);

export interface GrupoDoNumero {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
}

interface LinhaDeGrupo {
  group_chat_id: string;
  subject: string | null;
  enabled: boolean;
  enabled_at: string | null;
}

export interface GruposDb {
  lerSessao(
    org: string,
    sessionId: string,
  ): Promise<{ provider: ChannelProvider; sessionRef: string; groupsCapability: "full" | "limited" | "none" } | null>;
  listarLinhas(org: string, sessionId: string): Promise<LinhaDeGrupo[]>;
  contarLigados(org: string, sessionId: string): Promise<number>;
  gravarLinha(org: string, sessionId: string, row: LinhaDeGrupo & { enabled_by_user_id: string | null }): Promise<{ id: string }>;
}

export interface DepsDeGrupos {
  db: GruposDb;
  listGroups(provider: ChannelProvider, sessionRef: string): Promise<ChannelGroup[]>;
  /**
   * PODE LANÇAR (timeout/rede) mesmo declarando `Promise<boolean>` — o contrato
   * é "eu tento" e a exceção é um resultado, não um bug de tipo. Quem chama
   * (`alternarGrupo`) trata a exceção exatamente como `false`: nada fica ligado
   * sem estar confirmado.
   */
  setGroupIntake(provider: ChannelProvider, sessionRef: string, receive: boolean): Promise<boolean>;
  audit(entry: {
    action: string;
    organizationId: string;
    actorUserId: string;
    resourceId: string;
    requestId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  agora(): Date;
}

async function sessaoComGrupos(deps: DepsDeGrupos, org: string, sessionId: string) {
  const s = await deps.db.lerSessao(org, sessionId);
  if (!s) throw new GrupoError("sessao_nao_encontrada");
  if (s.groupsCapability === "none") throw new GrupoError("canal_sem_grupos");
  return s;
}

export async function listarGruposDoNumero(
  deps: DepsDeGrupos,
  e: { organizationId: string; channelSessionId: string },
): Promise<GrupoDoNumero[]> {
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  const [doCanal, gravados] = await Promise.all([
    deps.listGroups(s.provider, s.sessionRef),
    deps.db.listarLinhas(e.organizationId, e.channelSessionId),
  ]);
  const porId = new Map(gravados.map((l) => [l.group_chat_id, l]));
  return doCanal.map((g) => {
    const l = porId.get(g.chatId);
    return { chatId: g.chatId, subject: g.subject ?? l?.subject ?? null, enabled: l?.enabled ?? false, enabledAt: l?.enabled_at ?? null };
  });
}

export async function alternarGrupo(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string;
    groupChatId: string;
    subject: string | null;
    ligar: boolean;
    actorUserId: string;
    requestId: string;
  },
): Promise<{ enabled: boolean }> {
  chatIdDeGrupo.parse(e.groupChatId);
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  const ligados = await deps.db.contarLigados(e.organizationId, e.channelSessionId);
  const precisaTrocarFiltro = e.ligar ? ligados === 0 : ligados === 1;
  if (precisaTrocarFiltro) {
    // `setGroupIntake` pode LANÇAR (timeout, rede) em vez de resolver `false` —
    // as duas coisas significam a mesma coisa aqui: sem confirmação, nada liga.
    let confirmou: boolean;
    try {
      confirmou = await deps.setGroupIntake(s.provider, s.sessionRef, e.ligar);
    } catch {
      confirmou = false;
    }
    if (!confirmou) throw new GrupoError("filtro_nao_confirmado");
  }
  const agora = deps.agora().toISOString();
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: e.ligar,
    enabled_at: e.ligar ? agora : null,
    enabled_by_user_id: e.ligar ? e.actorUserId : null,
  });
  await deps.audit({
    action: e.ligar ? "channel.group_enabled" : "channel.group_disabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.groupChatId, filtro_trocado: precisaTrocarFiltro },
  });
  return { enabled: e.ligar };
}

/** Dependências reais. `admin` é service role: TODA consulta filtra `organization_id`. */
export function criarDepsDeGrupos(admin: SupabaseClient): DepsDeGrupos {
  return {
    db: {
      async lerSessao(org, sessionId) {
        const { data } = await admin
          .from("channel_sessions")
          .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
          .eq("organization_id", org)
          .eq("id", sessionId)
          .maybeSingle();
        if (!data) return null;
        const ref = data as unknown as ChannelSessionRef & { provider: ChannelProvider };
        return { provider: ref.provider, sessionRef: resolveSessionRef(ref), groupsCapability: capabilitiesOf(ref.provider).groups };
      },
      async listarLinhas(org, sessionId) {
        const { data } = await admin
          .from("channel_session_groups")
          .select("group_chat_id, subject, enabled, enabled_at")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId);
        return (data ?? []) as LinhaDeGrupo[];
      },
      async contarLigados(org, sessionId) {
        const { count } = await admin
          .from("channel_session_groups")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("enabled", true);
        return count ?? 0;
      },
      async gravarLinha(org, sessionId, row) {
        const { data, error } = await admin
          .from("channel_session_groups")
          .upsert({ organization_id: org, channel_session_id: sessionId, ...row }, { onConflict: "organization_id,channel_session_id,group_chat_id" })
          .select("id")
          .single();
        if (error) throw error;
        return data as { id: string };
      },
    },
    async listGroups(provider, sessionRef) {
      const adapter = getAdapter(provider);
      if (!adapter.listGroups) throw new GrupoError("canal_sem_grupos");
      return adapter.listGroups({ sessionRef });
    },
    async setGroupIntake(provider, sessionRef, receive) {
      const adapter = getAdapter(provider);
      return adapter.setGroupIntake ? adapter.setGroupIntake({ sessionRef, receive }) : false;
    },
    async audit(entry) {
      await auditReal({
        action: entry.action as AuditAction,
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId,
        resourceType: "channel_session_group",
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      });
    },
    agora: () => new Date(),
  };
}
