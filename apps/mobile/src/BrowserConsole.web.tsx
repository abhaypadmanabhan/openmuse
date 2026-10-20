import { useEffect, useRef } from "react";

export default function BrowserConsole({
  url,
  title = "Remote browser session console",
  sandboxed = false,
  inPlace = false,
}: {
  url: string;
  title?: string;
  sandboxed?: boolean;
  /** A new url replaces the page in place instead of adding a Back-button entry; a url that
   * changes only after `#` keeps the page, and its connection, loaded. */
  inPlace?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // In place, the first url stays the src; later ones go through location.replace.
  const first = useRef(url);
  const shown = useRef(url);
  useEffect(() => {
    if (!inPlace || url === shown.current) return;
    shown.current = url;
    frame.current?.contentWindow?.location.replace(url);
  }, [inPlace, url]);
  return (
    <iframe
      ref={frame}
      title={title}
      src={inPlace ? first.current : url}
      sandbox={sandboxed ? "allow-scripts allow-same-origin allow-pointer-lock" : undefined}
      referrerPolicy={sandboxed ? "no-referrer" : undefined}
      style={{ height: 540, width: "100%", border: 0, borderRadius: 12, background: "#FFF" }}
    />
  );
}
