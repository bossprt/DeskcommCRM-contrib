import { z } from "zod";

/**
 * Remetente de uma mensagem de GRUPO (`messages.metadata.group_sender`): nome, telefone e
 * lid de um participante, que não é contato do CRM.
 *
 * LGPD — FORA DA CASCATA DE PROPÓSITO (revisão final, 23/09/2026): este rótulo fica fora
 * da exportação e da anonimização LGPD (`fn_lgpd_cascade_redact_contact`,
 * `lib/lgpd/export-collector.ts`), que alcançam só o contato do grupo. O participante não
 * é contato do CRM e não há chave confiável para achá-lo por titular; o rótulo é de uso
 * interno do atendimento, sob a responsabilidade do controlador. Racional na spec
 * (docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md, "Fora desta versão").
 * Estender a cascata a este campo é mudança de desenho, não "completar" um esquecimento.
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
