import { z } from "zod";

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
