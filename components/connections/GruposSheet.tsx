"use client";
/**
 * Conexões › Grupos: quais grupos deste número aparecem na inbox. A rota
 * `GET/PUT /api/v1/channel-sessions/[id]/groups` já exige gerente+
 * (`requireRole("manager", ...)`); esta tela só monta atrás desse mesmo botão,
 * que `ConnectionsClient` só mostra dentro de `/app/connections` — página que
 * já barra quem é menos que admin (`app/app/connections/page.tsx`). Não há
 * segunda leitura de papel aqui: seria uma fonte paralela do mesmo dado.
 *
 * A IA nunca responde em grupo — o texto do cabeçalho diz isso, para que ligar
 * um grupo não pareça "a IA vai atender aqui também".
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

interface Grupo {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
  presente: boolean;
}

const AVISO_DE_VOLUME =
  "A partir de agora, o WhatsApp deste número passa a enviar mensagens de todos os grupos para o sistema. Só os grupos ligados aparecem no chat; os outros são descartados.";

export function GruposSheet({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, setPendente] = useState<Grupo | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`);
    const j = (await res.json().catch(() => null)) as { data?: Grupo[] } | null;
    if (!res.ok || !j?.data) {
      setErro(t("Não consegui ler os grupos deste número."));
      return;
    }
    setGrupos(j.data);
  }, [channelId, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function gravar(g: Grupo, enabled: boolean) {
    setSalvando(g.chatId);
    setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_chat_id: g.chatId, subject: g.subject, enabled }),
    });
    setSalvando(null);
    if (!res.ok) {
      setErro(
        res.status === 502
          ? t("O WhatsApp não confirmou a mudança. Nada foi alterado; tente de novo.")
          : t("Não foi possível salvar."),
      );
      return;
    }
    setGrupos((atual) => atual?.map((x) => (x.chatId === g.chatId ? { ...x, enabled } : x)) ?? null);
  }

  function alternar(g: Grupo, enabled: boolean) {
    const nenhumLigado = !(grupos ?? []).some((x) => x.enabled);
    if (enabled && nenhumLigado) {
      setPendente(g);
      return;
    }
    void gravar(g, enabled);
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("Grupos")}</SheetTitle>
          <SheetDescription>
            {t(
              "Grupos ligados aparecem no chat para os atendentes responderem. A IA nunca responde em grupo.",
            )}
          </SheetDescription>
        </SheetHeader>
        <Button variant="outline" size="sm" onClick={() => void carregar()}>
          {t("Atualizar lista")}
        </Button>
        {erro && (
          <p role="alert" className="text-sm text-destructive">
            {erro}
          </p>
        )}
        {pendente && (
          <div role="alertdialog" className="rounded-md border p-3 text-sm">
            <p>{t(AVISO_DE_VOLUME)}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const g = pendente;
                  setPendente(null);
                  void gravar(g, true);
                }}
              >
                {t("Ligar mesmo assim")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPendente(null)}>
                {t("Cancelar")}
              </Button>
            </div>
          </div>
        )}
        <ul className="mt-3 space-y-2">
          {(grupos ?? []).map((g) => (
            <li key={g.chatId} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-sm">{g.subject ?? t("Grupo sem nome")}</span>
                {!g.presente && (
                  <p className="text-xs text-muted-foreground">
                    {t("O número saiu deste grupo. Desligue a chave se não precisar mais dela.")}
                  </p>
                )}
              </div>
              <Switch
                aria-label={g.subject ?? t("Grupo sem nome")}
                checked={g.enabled}
                disabled={salvando === g.chatId}
                onCheckedChange={(v) => alternar(g, v)}
              />
            </li>
          ))}
        </ul>
        {grupos?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("Este número não está em nenhum grupo.")}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
