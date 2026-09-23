// lib/grupos/servico.test.ts
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

import { alternarGrupo, GrupoError, listarGruposDoNumero, type DepsDeGrupos } from "./servico";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const G1 = "1@g.us";
const G2 = "2@g.us";

function deps(opts: { ligados?: string[]; capability?: "full" | "none"; confirma?: boolean } = {}) {
  const linhas = new Map<
    string,
    { group_chat_id: string; subject: string | null; enabled: boolean; enabled_at: string | null }
  >();
  for (const g of opts.ligados ?? []) {
    linhas.set(g, { group_chat_id: g, subject: null, enabled: true, enabled_at: "2026-09-23T00:00:00.000Z" });
  }
  const d: DepsDeGrupos & { setGroupIntake: ReturnType<typeof vi.fn>; audit: ReturnType<typeof vi.fn> } = {
    db: {
      lerSessao: vi.fn(async () => ({
        provider: DEFAULT_CHANNEL_PROVIDER,
        sessionRef: "s1",
        groupsCapability: opts.capability ?? "full",
      })),
      listarLinhas: vi.fn(async () => [...linhas.values()]),
      contarLigados: vi.fn(async () => [...linhas.values()].filter((l) => l.enabled).length),
      gravarLinha: vi.fn(async (_o, _s, row) => {
        linhas.set(row.group_chat_id, row);
        return { id: "row-" + row.group_chat_id };
      }),
    },
    listGroups: vi.fn(async () => [
      { chatId: G1, subject: "Cliente A" },
      { chatId: G2, subject: "Família" },
    ]),
    setGroupIntake: vi.fn(async () => opts.confirma ?? true),
    audit: vi.fn(async () => {}),
    agora: () => new Date("2026-09-23T12:00:00.000Z"),
  };
  return d;
}
const base = { organizationId: ORG, channelSessionId: SESS, subject: "Cliente A", actorUserId: "u1", requestId: "r1" };

describe("listarGruposDoNumero", () => {
  it("junta a lista do WhatsApp com o estado gravado; o padrão é desligado", async () => {
    const r = await listarGruposDoNumero(deps({ ligados: [G1] }), { organizationId: ORG, channelSessionId: SESS });
    expect(r).toEqual([
      { chatId: G1, subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00.000Z" },
      { chatId: G2, subject: "Família", enabled: false, enabledAt: null },
    ]);
  });
  it("canal sem capacidade de grupos é recusado", async () => {
    await expect(listarGruposDoNumero(deps({ capability: "none" }), { organizationId: ORG, channelSessionId: SESS }))
      .rejects.toMatchObject({ code: "canal_sem_grupos" });
  });
});

describe("alternarGrupo", () => {
  it("ligar o PRIMEIRO grupo liga o recebimento no WhatsApp, grava e audita", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).resolves.toEqual({ enabled: true });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", true);
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.group_enabled", organizationId: ORG, actorUserId: "u1" }),
    );
  });
  it("ligar um SEGUNDO grupo não mexe no filtro", async () => {
    const d = deps({ ligados: [G2] });
    await alternarGrupo(d, { ...base, groupChatId: G1, ligar: true });
    expect(d.setGroupIntake).not.toHaveBeenCalled();
  });
  it("desligar o ÚLTIMO grupo volta a ignorar grupos", async () => {
    const d = deps({ ligados: [G1] });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: false })).resolves.toEqual({ enabled: false });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", false);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_disabled" }));
  });
  it("sem confirmação do WhatsApp, o grupo NÃO fica ligado e nada é gravado", async () => {
    const d = deps({ confirma: false });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toBeInstanceOf(GrupoError);
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
  it("id que não é de grupo é recusado antes de qualquer efeito", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: "5568999990000@c.us", ligar: true })).rejects.toThrow();
    expect(d.setGroupIntake).not.toHaveBeenCalled();
  });
  it("aceita chat id de grupo no formato legado com hífen (medido no servidor real)", async () => {
    const d = deps();
    const comHifen = "123-456@g.us";
    await expect(alternarGrupo(d, { ...base, groupChatId: comHifen, ligar: true })).resolves.toEqual({
      enabled: true,
    });
  });
  it("se setGroupIntake LANÇA (timeout/rede), trata como recusa: nada fica ligado nem gravado", async () => {
    const d = deps();
    d.setGroupIntake = vi.fn(async () => {
      throw new Error("timeout de rede");
    });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toBeInstanceOf(GrupoError);
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toMatchObject({
      code: "filtro_nao_confirmado",
    });
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
});
