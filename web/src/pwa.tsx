/// <reference types="vite/client" />
import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let pendingPrompt: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  pendingPrompt = event as InstallPrompt;
  window.dispatchEvent(new Event("pwa-install-ready"));
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("PWA registration failed", error));
  });
}

export function InstallButton() {
  const [prompt, setPrompt] = useState(pendingPrompt);
  useEffect(() => {
    const ready = () => setPrompt(pendingPrompt);
    const installed = () => { pendingPrompt = null; setPrompt(null); };
    window.addEventListener("pwa-install-ready", ready);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("pwa-install-ready", ready);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  if (!prompt) return null;
  return <button className="theme-toggle" onClick={async () => {
    pendingPrompt = null;
    setPrompt(null);
    await prompt.prompt();
    await prompt.userChoice;
  }}><Download size={16} aria-hidden="true" /><span>Install app</span></button>;
}
