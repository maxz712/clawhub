"use client";

import { useEffect } from "react";

/**
 * Set document.title while a component is mounted, restoring the previous title
 * on unmount. All repo pages are client components (they read params + fetch on
 * the client), so a Server Component `generateMetadata` can't title them — this
 * is the App-Router-with-client-pages workaround. Pass a falsy value to skip
 * (e.g. while data is still loading) and the title is left untouched.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}
