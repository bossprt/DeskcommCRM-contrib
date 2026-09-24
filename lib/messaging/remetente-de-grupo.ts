import { z } from "zod";

/**
 * Remetente de uma mensagem de GRUPO (`messages.metadata.group_sender`): nome, telefone e
 * lid de um participante, que não é contato do CRM.
 *
 * LGPD — DECISÃO DO DONO (revisão final, 23/09/2026): este rótulo fica FORA da exportação
 * e da anonimização LGPD (`fn_lgpd_cascade_redact_contact`, `lib/lgpd/export-collector.ts`),
 * que alcançam só o contato do grupo. É dado de uso interno, e o dado sensível é tratado
 * sob a responsabilidade do dono da operação. Registrado na spec
 * (docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md, "Fora desta versão").
 * Não "completar" a cascata sem nova decisão do dono.
 */
export const remetenteDeGrupoSchema = z.strictObject({
  name: z.string().min(1).max(200).nullable(),
  phone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  lid: z.string().regex(/^\d{5,40}$/).nullable(),
});

export type RemetenteDeGrupo = z.infer<typeof remetenteDeGrupoSchema>;

export function lerRemetenteDeGrupo(metadata: unknown): RemetenteDeGrupo | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruto = (metadata as Record<string, unknown>).group_sender;
  const r = remetenteDeGrupoSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

export function rotuloDoRemetente(r: RemetenteDeGrupo): string {
  if (r.name && r.phone) return `${r.name} · ${r.phone}`;
  return r.name ?? r.phone ?? "Participante";
}
