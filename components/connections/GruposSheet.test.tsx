import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GruposSheet } from "./GruposSheet";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
const resposta = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status }),
  );

describe("GruposSheet", () => {
  it("lista os grupos com o estado de cada um", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00Z", presente: true },
        { chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("Cliente A")).toBeInTheDocument();
    expect(screen.getByText("Família")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Cliente A/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Família/ })).not.toBeChecked();
  });

  it("ao ligar o primeiro grupo, avisa sobre o volume antes de enviar", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([{ chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true }]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: /Família/ }));
    expect(await screen.findByText(/passa a enviar mensagens de todos os grupos/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falha do WhatsApp mantém a chave desligada e mostra o erro", async () => {
    fetchMock
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
          { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
        ]),
      )
      .mockReturnValueOnce(resposta({ code: "filtro_nao_confirmado", message: "x" }, 502));
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    const chave = await screen.findByRole("switch", { name: /^A/ });
    fireEvent.click(chave);
    await waitFor(() => expect(screen.getByText(/não confirmou/i)).toBeInTheDocument());
    expect(chave).not.toBeChecked();
  });

  it("grupo que o número não integra mais aparece com aviso para desligar", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "3@g.us", subject: "Grupo Antigo", enabled: true, enabledAt: "x", presente: false },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("Grupo Antigo")).toBeInTheDocument();
    expect(screen.getByText(/o número saiu deste grupo/i)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Grupo Antigo/ })).toBeChecked();
  });
});
