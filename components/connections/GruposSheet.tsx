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
 *
 * Um número pode estar em 100+ grupos: a lista SEMPRE rola dentro do próprio
 * container (`overflow-y-auto` + `min-h-0 flex-1`), nunca a folha inteira —
 * cabeçalho, busca, contador e ações continuam visíveis. Sem isso, grupo além
 * da dobra do viewport era inalcançável.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const AVISO_DE_DESLIGAR_TODOS =
  "Todos os grupos ligados deste número vão parar de aparecer no chat, e o número vai parar de receber mensagens de grupo.";

/** Busca insensível a maiúscula/minúscula e a acento: "grupo sao" acha "Grupo São". */
function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

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
  const [busca, setBusca] = useState("");
  const [confirmarDesligarTodos, setConfirmarDesligarTodos] = useState(false);
  const [progressoDesligar, setProgressoDesligar] = useState<{
    atual: number;
    total: number;
  } | null>(null);

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

  /**
   * Desliga todos os grupos ligados, um PUT por vez — NUNCA em paralelo. O
   * servidor decide o filtro de grupo do WhatsApp contando linhas `enabled`;
   * disparar em paralelo faria duas escritas concorrentes brigarem por essa
   * contagem. Para no primeiro erro (e diz qual grupo falhou e quantos já
   * foram desligados); sempre recarrega a lista do GET no fim, sucesso ou não.
   */
  async function desligarTodos() {
    const alvos = (grupos ?? []).filter((g) => g.enabled);
    const total = alvos.length;
    setConfirmarDesligarTodos(false);
    setErro(null);
    setProgressoDesligar({ atual: 0, total });
    let desligados = 0;
    // `carregar()` limpa `erro` no início — se a mensagem de falha fosse
    // gravada antes do `await carregar()` do `finally`, o próprio reload a
    // apagaria antes de qualquer um vê-la. Por isso ela é só ARMADA aqui e
    // aplicada DEPOIS do reload.
    let mensagemDeFalha: string | null = null;
    try {
      for (const g of alvos) {
        setProgressoDesligar({ atual: desligados + 1, total });
        const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group_chat_id: g.chatId, subject: g.subject, enabled: false }),
        });
        if (!res.ok) {
          const rotulo = g.subject ?? t("Grupo sem nome");
          mensagemDeFalha = `${t("Não foi possível desligar todos os grupos.")} ${t("Falhou em")} "${rotulo}" ${t("depois de desligar")} ${desligados}.`;
          return;
        }
        desligados++;
      }
    } finally {
      setProgressoDesligar(null);
      await carregar();
      if (mensagemDeFalha) setErro(mensagemDeFalha);
    }
  }

  const ligados = (grupos ?? []).filter((g) => g.enabled).length;
  const total = grupos?.length ?? 0;

  const filtrados = useMemo(() => {
    const alvo = normalizarBusca(busca);
    return (grupos ?? []).filter((g) =>
      normalizarBusca(g.subject ?? t("Grupo sem nome")).includes(alvo),
    );
  }, [grupos, busca, t]);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex h-full w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("Grupos")}</SheetTitle>
          <SheetDescription>
            {t(
              "Grupos ligados aparecem no chat para os atendentes responderem. A IA nunca responde em grupo.",
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 pb-2 pt-3">
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => void carregar()}>
              {t("Atualizar lista")}
            </Button>
            {ligados >= 1 && (
              <Button
                variant="outline"
                size="sm"
                disabled={progressoDesligar !== null}
                onClick={() => setConfirmarDesligarTodos(true)}
              >
                {t("Desligar todos")}
              </Button>
            )}
          </div>

          {grupos && (
            <p className="text-sm text-muted-foreground">
              {ligados} {t("de")} {total} {t("ligados")}
            </p>
          )}

          {progressoDesligar && (
            <p className="text-xs text-muted-foreground" role="status">
              {t("Desligando")} {progressoDesligar.atual} {t("de")} {progressoDesligar.total}
            </p>
          )}

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

          {confirmarDesligarTodos && (
            <div role="alertdialog" className="rounded-md border p-3 text-sm">
              <p>{t(AVISO_DE_DESLIGAR_TODOS)}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void desligarTodos()}>
                  {t("Desligar todos mesmo assim")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmarDesligarTodos(false)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          )}

          {grupos && grupos.length > 0 && (
            <Input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar grupo")}
              aria-label={t("Buscar grupo")}
            />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="space-y-2">
            {filtrados.map((g) => (
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
                  disabled={salvando === g.chatId || progressoDesligar !== null}
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
          {grupos && grupos.length > 0 && filtrados.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("Nenhum grupo encontrado")}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
