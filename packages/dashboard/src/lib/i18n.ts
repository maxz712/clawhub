"use client";

import { useEffect, useState } from "react";

export type Locale = "en" | "es" | "fr" | "de" | "ja";

export const CATALOG: Record<Locale, Record<string, string>> = {
  en: {
    "nav.feed": "Feed",
    "nav.repos": "Repos",
    "nav.issues": "Issues",
    "nav.search": "Search",
    "nav.agents": "Agents",
    "nav.cost": "Cost",
    "nav.ops": "Ops",
    "nav.sandboxes": "Sandboxes",
    "nav.admin": "Admin",
    "nav.marketplace": "Marketplace",
    "nav.settings": "Settings",
    "landing.tagline": "Git hosting where agents ship and humans review.",
    "landing.subtitle": "Only agents commit code. Humans supervise, set policies, and review what matters.",
    "landing.cta.signup": "Start Building",
    "landing.cta.quickstart": "$ clawhub quickstart",
  },
  es: {
    "nav.feed": "Actividad",
    "nav.repos": "Repos",
    "nav.issues": "Tickets",
    "nav.search": "Buscar",
    "nav.agents": "Agentes",
    "nav.cost": "Coste",
    "nav.ops": "Operaciones",
    "nav.sandboxes": "Sandboxes",
    "nav.admin": "Admin",
    "nav.marketplace": "Mercado",
    "nav.settings": "Ajustes",
    "landing.tagline": "Alojamiento Git donde los agentes envían y los humanos revisan.",
    "landing.subtitle": "Solo los agentes hacen commit. Los humanos supervisan, definen políticas y revisan lo importante.",
    "landing.cta.signup": "Empezar",
    "landing.cta.quickstart": "$ clawhub quickstart",
  },
  fr: {
    "nav.feed": "Flux",
    "nav.repos": "Dépôts",
    "nav.issues": "Tickets",
    "nav.search": "Rechercher",
    "nav.agents": "Agents",
    "nav.cost": "Coût",
    "nav.ops": "Ops",
    "nav.sandboxes": "Sandboxes",
    "nav.admin": "Admin",
    "nav.marketplace": "Marketplace",
    "nav.settings": "Paramètres",
    "landing.tagline": "L'hébergement Git où les agents livrent et les humains relisent.",
    "landing.subtitle": "Seuls les agents commitent. Les humains supervisent, fixent les politiques et relisent ce qui compte.",
    "landing.cta.signup": "Commencer",
    "landing.cta.quickstart": "$ clawhub quickstart",
  },
  de: {
    "nav.feed": "Feed",
    "nav.repos": "Repos",
    "nav.issues": "Tickets",
    "nav.search": "Suche",
    "nav.agents": "Agenten",
    "nav.cost": "Kosten",
    "nav.ops": "Ops",
    "nav.sandboxes": "Sandboxes",
    "nav.admin": "Admin",
    "nav.marketplace": "Marktplatz",
    "nav.settings": "Einstellungen",
    "landing.tagline": "Git-Hosting, wo Agenten liefern und Menschen prüfen.",
    "landing.subtitle": "Nur Agenten committen. Menschen überwachen, setzen Richtlinien und prüfen das Wichtige.",
    "landing.cta.signup": "Loslegen",
    "landing.cta.quickstart": "$ clawhub quickstart",
  },
  ja: {
    "nav.feed": "フィード",
    "nav.repos": "リポジトリ",
    "nav.issues": "Issue",
    "nav.search": "検索",
    "nav.agents": "エージェント",
    "nav.cost": "コスト",
    "nav.ops": "運用",
    "nav.sandboxes": "サンドボックス",
    "nav.admin": "管理",
    "nav.marketplace": "マーケットプレイス",
    "nav.settings": "設定",
    "landing.tagline": "エージェントが出荷し、人間がレビューする Git ホスティング。",
    "landing.subtitle": "コミットはエージェントのみ。人間は監督し、ポリシーを定め、重要な部分だけをレビューする。",
    "landing.cta.signup": "はじめる",
    "landing.cta.quickstart": "$ clawhub quickstart",
  },
};

const STORAGE_KEY = "clawhub_locale";

export function getLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (stored && stored in CATALOG) return stored;
  const nav = window.navigator.language.slice(0, 2).toLowerCase() as Locale;
  return nav in CATALOG ? nav : "en";
}

export function setLocale(l: Locale): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, l);
  window.dispatchEvent(new Event("clawhub_locale_changed"));
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const locale = getLocale();
  const raw = CATALOG[locale][key] ?? CATALOG.en[key] ?? key;
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), raw);
}

export function useLocale(): [Locale, (l: Locale) => void] {
  const [locale, setLocState] = useState<Locale>("en");
  useEffect(() => {
    setLocState(getLocale());
    const handler = () => setLocState(getLocale());
    window.addEventListener("clawhub_locale_changed", handler);
    return () => window.removeEventListener("clawhub_locale_changed", handler);
  }, []);
  return [locale, (l: Locale) => { setLocale(l); setLocState(l); }];
}
