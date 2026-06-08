import sharp from "sharp";
import { epaperDisplayById, type EpaperDisplayDefinition, type EpaperStatDefinition } from "./displays";
import type { MatterLayerRuntime } from "./runtime/engine";

type Snapshot = ReturnType<MatterLayerRuntime["snapshot"]>;
type SnapshotTarget = Snapshot["targets"][number];
type SnapshotSource = Snapshot["sources"][number];
type SnapshotLayer = Snapshot["layers"][number];
type MatterResolvedBinding = {
  key: string;
  nodeId: number;
  label?: string;
  available?: boolean;
};
type MatterStatus = {
  enabled?: boolean;
  connected?: boolean;
  nodeCount?: number;
  lastMessageAt?: number;
  resolved?: MatterResolvedBinding[];
};
type MatterProviderSnapshot = { name: string; status: MatterStatus | null } | undefined;
type EpaperExpandedDep = { source: string; active: boolean };
const epaperFontFamily = "Inter, Arial, sans-serif";
const epaperInactiveLine = "#999999";

export type EpaperPalette = "mono" | "grayscale" | "color";
export type EpaperFormat = "svg" | "png";
export type EpaperProfile = {
  id: string;
  width: number;
  height: number;
  palette: EpaperPalette;
  background: string;
  foreground: string;
  accent: string;
  inverse: string;
  inverseText: string;
};

export type EpaperRenderOptions = Partial<Pick<EpaperProfile, "width" | "height" | "palette">> & {
  profile?: string;
  room?: string;
  title?: string;
  now?: number;
};

export type EpaperRenderState = {
  displayId: string;
  room: string;
  title: string;
  width: number;
  height: number;
  palette: EpaperPalette;
  fingerprint: string;
  generatedAt: number;
};

export const epaperProfiles: Record<string, EpaperProfile> = {
  "xiao-7.5-mono": {
    id: "xiao-7.5-mono",
    width: 800,
    height: 480,
    palette: "mono",
    background: "#fbfbf6",
    foreground: "#000",
    accent: "#000",
    inverse: "#000",
    inverseText: "#fff",
  },
};

const statValueCache = new Map<string, { value: string; updatedAt: number }>();
const renderCache = new Map<string, { fingerprint: string; generatedAt: number; svg: string }>();
const pngCache = new Map<string, { fingerprint: string; generatedAt: number; png: Buffer }>();

export function resolveEpaperProfile(options: EpaperRenderOptions = {}): EpaperProfile {
  const base = epaperProfiles[options.profile ?? "xiao-7.5-mono"] ?? epaperProfiles["xiao-7.5-mono"];
  return {
    ...base,
    width: sanitizeDimension(options.width, base.width),
    height: sanitizeDimension(options.height, base.height),
    palette: options.palette ?? base.palette,
  };
}

export function renderRoomEpaperPanelSvg(snapshot: Snapshot, options: EpaperRenderOptions = {}) {
  const { resolvedOptions, now, fingerprint } = resolveEpaperRender(snapshot, options);
  const cacheKey = epaperCacheKey(resolvedOptions);
  const cached = renderCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return cached.svg;
  const svg = renderRoomEpaperSvg(snapshot, resolvedOptions, now);
  renderCache.set(cacheKey, { fingerprint, generatedAt: now, svg });
  return svg;
}

export async function renderRoomEpaperPanelPng(snapshot: Snapshot, options: EpaperRenderOptions = {}) {
  const { resolvedOptions, profile, now, fingerprint } = resolveEpaperRender(snapshot, options);
  const cacheKey = `${epaperCacheKey(resolvedOptions)}:png`;
  const cached = pngCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return cached.png;
  const svg = renderRoomEpaperPanelSvg(snapshot, options);
  let png: Buffer;
  if (profile.palette === "mono") {
    const image = sharp(Buffer.from(svg)).flatten({ background: profile.background });
    png = await image.grayscale().threshold(128).png({ compressionLevel: 9, palette: true, colors: 2 }).toBuffer();
  } else if (profile.palette === "grayscale") {
    png = await renderCrispGrayscalePng(svg, profile);
  } else {
    const image = sharp(Buffer.from(svg), { density: 216 })
      .resize(profile.width, profile.height, { fit: "fill", kernel: "lanczos3" })
      .flatten({ background: profile.background });
    png = await image.png({ compressionLevel: 9 }).toBuffer();
  }
  pngCache.set(cacheKey, { fingerprint, generatedAt: now, png });
  return png;
}

export function getEpaperRenderState(snapshot: Snapshot, options: EpaperRenderOptions = {}): EpaperRenderState {
  const { resolvedOptions, profile, now, fingerprint } = resolveEpaperRender(snapshot, options);
  return {
    displayId: resolvedOptions.display.id,
    room: resolvedOptions.room,
    title: resolvedOptions.title,
    width: profile.width,
    height: profile.height,
    palette: profile.palette,
    fingerprint,
    generatedAt: now,
  };
}

export const renderOfficeEpaperSvg = renderRoomEpaperPanelSvg;
export const renderOfficeEpaperPng = renderRoomEpaperPanelPng;

function resolveEpaperRender(snapshot: Snapshot, options: EpaperRenderOptions = {}) {
  const display = epaperDisplayById(options.room);
  const resolvedOptions = {
    ...options,
    room: display.room,
    title: options.title ?? (display.title ?? humanRoomName(display.room)).toUpperCase(),
    display,
  };
  const profile = resolveEpaperProfile(options);
  const now = floorToMinute(options.now ?? Date.now());
  return {
    resolvedOptions,
    profile,
    now,
    fingerprint: epaperRenderFingerprint(snapshot, resolvedOptions, now),
  };
}

async function renderCrispGrayscalePng(svg: string, profile: EpaperProfile) {
  const baseSvg = removeEpaperText(svg);
  const textSvg = epaperTextOverlaySvg(svg, profile);
  const base = await sharp(Buffer.from(baseSvg)).flatten({ background: profile.background }).grayscale().png().toBuffer();
  const text = await sharp(Buffer.from(textSvg), { density: 216 })
    .resize(profile.width, profile.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const textOverlay = sharpenTextAlpha(text.data, text.info.width, text.info.height, text.info.channels);
  return sharp(base)
    .composite([{ input: textOverlay, raw: { width: text.info.width, height: text.info.height, channels: 4 }, blend: "over" }])
    .removeAlpha()
    .grayscale()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function addEpaperTextCrispPass(svg: string) {
  return svg.replace(/<text\b([^>]*)>/g, (tag, attrs: string) => {
    if (/\bstroke=/.test(attrs)) return tag;
    const fill = attrs.match(/\bfill="([^"]+)"/)?.[1];
    if (!fill || fill === "none" || fill.startsWith("url(")) return tag;
    return `<text${attrs} stroke="${fill}" stroke-width="0.04" stroke-linejoin="round" paint-order="stroke fill">`;
  });
}

function removeEpaperText(svg: string) {
  return svg.replace(/<text\b[\s\S]*?<\/text>/g, "");
}

function epaperTextOverlaySvg(svg: string, profile: EpaperProfile) {
  const text = Array.from(svg.matchAll(/<text\b[\s\S]*?<\/text>/g), (match) => addEpaperTextCrispPass(match[0])).join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${profile.width}" height="${profile.height}" viewBox="0 0 ${profile.width} ${profile.height}">
  <defs><style>text{font-kerning:none;}</style></defs>
  ${text}
</svg>`;
}

function sharpenTextAlpha(data: Buffer, width: number, height: number, channels: number) {
  const output = Buffer.from(data);
  if (channels < 4) return output;
  for (let index = 0; index < output.length; index += channels) {
    const alpha = output[index + 3];
    if (alpha === 0) continue;
    const normalized = alpha / 255;
    const contrasted = normalized < 0.18
      ? normalized * 0.55
      : Math.pow(normalized, 0.68);
    output[index + 3] = Math.max(0, Math.min(255, Math.round(contrasted * 255)));
  }
  return output;
}

function renderRoomEpaperSvg(snapshot: Snapshot, options: EpaperRenderOptions & { room: string; title: string; display: EpaperDisplayDefinition }, renderNow?: number) {
  const profile = resolveEpaperProfile(options);
  const scaleX = profile.width / 800;
  const scaleY = profile.height / 480;
  const now = renderNow ?? floorToMinute(options.now ?? Date.now());
  const roomSnapshot = filterSnapshot(snapshot, options.room);
  const sourceById = new Map(roomSnapshot.sources.map((source) => [source.source, source]));
  const layerByTarget = new Map(roomSnapshot.layers.map((layer) => [layer.target, layer]));
  const targetById = new Map(roomSnapshot.targets.map((target) => [target.target, target]));
  const statCards = epaperStats(snapshot, options.display.stats ?? [], now);
  const matter = snapshot.providers.find((provider) => provider.name === "matter") as MatterProviderSnapshot;
  const bindingByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const devices = visibleDeviceTargets(roomSnapshot.targets, options.display)
    .map((target) => {
      const layer = layerByTarget.get(target.target);
      const status = deviceStatus(target, sourceById, layer);
      const binding = bindingByKey.get(target.key) ?? bindingByKey.get(target.target);
      const health = deviceProviderHealth(target, matter, binding);
      return {
        label: truncateMiddle(deviceDisplayLabel(binding?.label ?? target.key, target, options.room), 30),
        status: status?.label ?? health.label,
        tone: status?.tone ?? health.tone,
        online: health.tone !== "bad",
        icon: epaperDeviceIconKind(target, status?.label),
        layer: layer?.surfaced?.layer,
        detail: layer?.surfaced?.layer ?? "",
      };
    });
  const compactDevices = devices.length > 9;
  const onlineDevices = compactDevices
    ? devices.filter((device) => device.online).slice(0, 11)
    : devices.filter((device) => device.online).slice(0, devices.some((device) => !device.online) ? 6 : 9);
  const offlineDevices = compactDevices
    ? devices.filter((device) => !device.online).slice(0, 4)
    : devices.filter((device) => !device.online).slice(0, 2);
  const deviceRowStep = compactDevices ? 25 : 47;
  const offlineHeaderY = 100 + onlineDevices.length * deviceRowStep + (compactDevices ? 15 : 18);
  const signalById = new Map(snapshot.signals.map((signal) => [signal.id, signal]));
  const transitiveDepActiveById = epaperTransitiveDepActivity(snapshot, now);
  const activeFlowSources = new Set<string>();
  const activeFlowSinks = new Set<string>();
  const automations = [
    ...roomSnapshot.rules.map((rule) => {
      const deps = uniqueEpaperDepStates(rule.deps.flatMap((dep) => expandEpaperSourceDeps(dep, signalById, sourceById, transitiveDepActiveById)), 8);
      const outputWrites = epaperRuleOutputWrites(rule, roomSnapshot.layers);
      const outputs = epaperVisibleFlowOutputs(outputWrites.map((write) => write.target), targetById);
      for (const dep of deps) {
        if (dep.active) activeFlowSources.add(epaperFlowLabel(dep.source, options.room, 48));
      }
      for (const output of outputs) {
        if (epaperOutputActive(layerByTarget.get(output)?.surfaced?.output.state)) activeFlowSinks.add(epaperFlowLabel(output, options.room, 48));
      }
      return {
        name: rule.name,
        enabled: rule.enabled,
        deps: deps.map((dep) => epaperFlowLabel(dep.source, options.room, 48)),
        outputs: outputs.map((output) => epaperFlowLabel(output, options.room, 48)),
        activeOutputs: outputWrites
          .filter((write) => write.hasOutput && outputs.includes(write.target))
          .map((write) => epaperFlowLabel(write.target, options.room, 48)),
        lastRunAt: rule.lastRunAt,
      };
    }),
    ...(roomSnapshot.eventActions ?? []).map((action) => {
      if (action.lastRunAt && now - action.lastRunAt <= 5 * 60 * 1000) activeFlowSources.add(epaperFlowLabel(action.event, options.room, 48));
      const outputs = epaperVisibleFlowOutputs(action.outputs, targetById);
      for (const output of outputs) {
        if (epaperOutputActive(layerByTarget.get(output)?.surfaced?.output.state)) activeFlowSinks.add(epaperFlowLabel(output, options.room, 48));
      }
      return {
        name: action.name,
        enabled: true,
        deps: [epaperFlowLabel(action.event, options.room, 48)],
        outputs: outputs.map((output) => epaperFlowLabel(output, options.room, 48)),
        activeOutputs: outputs
          .filter((output) => eventActionHasEpaperOpinion(layerByTarget.get(output)))
          .map((output) => epaperFlowLabel(output, options.room, 48)),
        lastRunAt: action.lastRunAt,
      };
    }),
  ].filter((automation) => automation.outputs.length > 0).slice(0, 6);
  const flowY = statCards.length ? 142 : 100;
  const flow = buildEpaperFlow(automations, activeFlowSources, activeFlowSinks, flowY);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${profile.width}" height="${profile.height}" viewBox="0 0 ${profile.width} ${profile.height}">
  <defs>
    <style>text{font-kerning:none;}rect,line{shape-rendering:crispEdges;}</style>
    <pattern id="epaper-grid" width="${20 * scaleX}" height="${20 * scaleY}" patternUnits="userSpaceOnUse">
      <path d="M ${20 * scaleX} 0 L 0 0 0 ${20 * scaleY}" fill="none" stroke="${profile.foreground}" stroke-opacity="0.08" stroke-width="${Math.max(1, scaleX)}"/>
    </pattern>
    <pattern id="epaper-hatch" width="${6 * scaleX}" height="${6 * scaleY}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${6 * scaleY}" stroke="${profile.foreground}" stroke-opacity="0.22" stroke-width="${Math.max(1, 2 * scaleX)}"/>
    </pattern>
  </defs>
  <rect width="${profile.width}" height="${profile.height}" fill="${profile.background}"/>
  <rect width="${profile.width}" height="${profile.height}" fill="url(#epaper-grid)"/>
  <rect x="0" y="0" width="${profile.width}" height="${48 * scaleY}" fill="${profile.inverse}"/>
  <text x="${snap(24 * scaleX)}" y="${snap(31 * scaleY)}" fill="${profile.inverseText}" font-family="${epaperFontFamily}" font-size="${snap(24 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(options.title.toUpperCase())}</text>
  <text x="${snap(24 * scaleX)}" y="${snap(76 * scaleY)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(14 * Math.min(scaleX, scaleY))}" font-weight="900">DEVICES</text>
  <text x="${snap(408 * scaleX)}" y="${snap(76 * scaleY)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(14 * Math.min(scaleX, scaleY))}" font-weight="900">DRIVES</text>
  <line x1="${24 * scaleX}" y1="${84 * scaleY}" x2="${386 * scaleX}" y2="${84 * scaleY}" stroke="${profile.foreground}" stroke-width="${2 * Math.min(scaleX, scaleY)}"/>
  <line x1="${408 * scaleX}" y1="${84 * scaleY}" x2="${776 * scaleX}" y2="${84 * scaleY}" stroke="${profile.foreground}" stroke-width="${2 * Math.min(scaleX, scaleY)}"/>
  ${statCards.length ? renderStatCards(statCards, profile, scaleX, scaleY) : ""}
  ${devices.length ? renderDeviceSections(onlineDevices, offlineDevices, offlineHeaderY, compactDevices, deviceRowStep, profile, scaleX, scaleY) : renderEmptyText(24, 128, "No devices resolved.", profile, scaleX, scaleY)}
  ${flow.edges.length ? renderFlowGraph(flow, profile, scaleX, scaleY) : renderEmptyText(408, statCards.length ? 160 : 128, "No drives.", profile, scaleX, scaleY)}
</svg>`;
}

function renderStatCards(
  stats: Array<{ label: string; value: string }>,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const cardWidth = 116;
  return `<g>
    ${stats.slice(0, 3).map((stat, index) => {
      const x = (408 + index * 123) * scaleX;
      return `<g>
        <rect x="${x}" y="${92 * scaleY}" width="${cardWidth * scaleX}" height="${36 * scaleY}" fill="${profile.background}" stroke="${profile.foreground}" stroke-width="${2 * Math.min(scaleX, scaleY)}"/>
        <text x="${snap(x + 8 * scaleX)}" y="${snap(106 * scaleY)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(8 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(stat.label.toUpperCase())}</text>
        <text x="${snap(x + 8 * scaleX)}" y="${snap(123 * scaleY)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(19 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(stat.value)}</text>
      </g>`;
    }).join("\n    ")}
  </g>`;
}

function renderDeviceSections(
  onlineDevices: Array<{ label: string; status: string; tone?: string; online: boolean; icon: EpaperDeviceIconKind; layer?: string; detail: string }>,
  offlineDevices: Array<{ label: string; status: string; tone?: string; online: boolean; icon: EpaperDeviceIconKind; layer?: string; detail: string }>,
  offlineHeaderY: number,
  compact: boolean,
  rowStep: number,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const onlineSvg = onlineDevices.map((device, index) => compact
    ? renderCompactDeviceRow(device, 100 + index * rowStep, profile, scaleX, scaleY)
    : renderDeviceRow(device, 100 + index * rowStep, profile, scaleX, scaleY)).join("\n  ");
  if (!offlineDevices.length) return onlineSvg;
  const y = offlineHeaderY * scaleY;
  const offlineSvg = offlineDevices.map((device, index) => compact
    ? renderCompactDeviceRow(device, offlineHeaderY + 8 + index * rowStep, profile, scaleX, scaleY)
    : renderDeviceRow(device, offlineHeaderY + 12 + index * rowStep, profile, scaleX, scaleY)).join("\n  ");
  return `${onlineSvg}
  <text x="${snap(24 * scaleX)}" y="${snap(y)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(12 * Math.min(scaleX, scaleY))}" font-weight="900">OFFLINE</text>
  <line x1="${82 * scaleX}" y1="${y - 4 * scaleY}" x2="${386 * scaleX}" y2="${y - 4 * scaleY}" stroke="${profile.foreground}" stroke-width="${1.5 * Math.min(scaleX, scaleY)}"/>
  ${offlineSvg}`;
}

function renderCompactDeviceRow(
  device: { label: string; status: string; tone?: string; online: boolean; icon: EpaperDeviceIconKind; layer?: string; detail: string },
  baseY: number,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const row = epaperDeviceRowColors(device.tone, profile);
  const y = baseY * scaleY;
  const layer = device.layer ?? "";
  return `<g>
    <rect x="${24 * scaleX}" y="${y}" width="${362 * scaleX}" height="${20 * scaleY}" fill="${row.bg}" stroke="${profile.foreground}" stroke-width="${1.5 * Math.min(scaleX, scaleY)}"/>
    ${renderCompactDeviceIcon(device.icon, 34, baseY + 3, row.inverted, profile, scaleX, scaleY)}
    <text x="${snap(58 * scaleX)}" y="${snap(y + 14 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(11 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(truncateText(device.label, 20))}</text>
    <text x="${snap(190 * scaleX)}" y="${snap(y + 14 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(9 * Math.min(scaleX, scaleY))}" font-weight="900">${layer ? `[${escapeXml(truncateText(layer, 17))}]` : ""}</text>
    <text x="${snap(374 * scaleX)}" y="${snap(y + 14 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(10 * Math.min(scaleX, scaleY))}" font-weight="900" text-anchor="end">${escapeXml(truncateText(device.status.toUpperCase(), 10))}</text>
  </g>`;
}

function renderDeviceRow(
  device: { label: string; status: string; tone?: string; online: boolean; icon: EpaperDeviceIconKind; layer?: string; detail: string },
  baseY: number,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const row = epaperDeviceRowColors(device.tone, profile);
  const y = baseY * scaleY;
  return `<g>
    <rect x="${24 * scaleX}" y="${y}" width="${362 * scaleX}" height="${38 * scaleY}" fill="${row.bg}" stroke="${profile.foreground}" stroke-width="${2 * Math.min(scaleX, scaleY)}"/>
    <rect x="${24 * scaleX}" y="${y}" width="${9 * scaleX}" height="${38 * scaleY}" fill="${device.layer ? profile.accent : "url(#epaper-hatch)"}"/>
    ${renderDeviceIcon(device.icon, 43, baseY + 8, row.inverted, profile, scaleX, scaleY)}
    <text x="${snap(70 * scaleX)}" y="${snap(y + 16 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(14 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(truncateText(device.label, 28))}</text>
    <text x="${snap(70 * scaleX)}" y="${snap(y + 31 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(10 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(truncateText(device.layer || "no active layer", 33))}</text>
    <text x="${snap(374 * scaleX)}" y="${snap(y + 17 * scaleY)}" fill="${row.fg}" font-family="${epaperFontFamily}" font-size="${snap(12 * Math.min(scaleX, scaleY))}" font-weight="900" text-anchor="end">${escapeXml(truncateText(device.status.toUpperCase(), 11))}</text>
  </g>`;
}

type EpaperDeviceIconKind = "light-on" | "light-off" | "light" | "blind" | "presence" | "door" | "generic";

function epaperDeviceRowColors(tone: string | undefined, profile: EpaperProfile) {
  const inverted = tone === "off";
  return {
    bg: inverted ? profile.inverse : profile.background,
    fg: inverted ? profile.inverseText : profile.foreground,
    inverted,
  };
}

function epaperDeviceIconKind(target: SnapshotTarget, status?: string): EpaperDeviceIconKind {
  const product = String(target.capabilities?.product ?? "").toLowerCase();
  if (target.capabilities?.position || target.capabilities?.commands) return "blind";
  if (target.capabilities?.power) {
    if (status === "on") return "light-on";
    if (status === "off") return "light-off";
    return "light";
  }
  if (product.includes("presence")) return "presence";
  if (status === "open" || status === "closed" || product.includes("door")) return "door";
  return "generic";
}

function renderCompactDeviceIcon(
  kind: EpaperDeviceIconKind,
  baseX: number,
  baseY: number,
  active: boolean,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const scale = 0.72 * Math.min(scaleX, scaleY);
  return `<g transform="translate(${baseX * scaleX} ${baseY * scaleY}) scale(${scale})">
    ${renderDeviceIcon(kind, 0, 0, active, profile, 1, 1)}
  </g>`;
}

function renderDeviceIcon(
  kind: EpaperDeviceIconKind,
  baseX: number,
  baseY: number,
  active: boolean,
  profile: EpaperProfile,
  scaleX: number,
  scaleY: number,
) {
  const x = baseX * scaleX;
  const y = baseY * scaleY;
  const s = Math.min(scaleX, scaleY);
  const stroke = active ? profile.inverseText : profile.foreground;
  const fill = active ? profile.inverse : profile.background;
  const common = `stroke="${stroke}" stroke-width="${1.8 * s}" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "light" || kind === "light-on" || kind === "light-off") {
    const rays = kind === "light-on"
      ? `<path d="M ${x + 3 * scaleX} ${y + 2 * scaleY} l ${-2 * scaleX} ${-2 * scaleY} M ${x + 11 * scaleX} ${y + 2 * scaleY} l ${2 * scaleX} ${-2 * scaleY} M ${x + 7 * scaleX} ${y} v ${-3 * scaleY}"/>`
      : "";
    return `<g ${common} fill="none">
      <path d="M ${x + 7 * scaleX} ${y + 4 * scaleY} a ${6 * scaleX} ${6 * scaleY} 0 0 1 ${4 * scaleX} ${10 * scaleY} c ${-1 * scaleX} ${1 * scaleY} ${-1.5 * scaleX} ${2 * scaleY} ${-1.5 * scaleX} ${3 * scaleY} h ${-5 * scaleX} c 0 ${-1 * scaleY} ${-0.5 * scaleX} ${-2 * scaleY} ${-1.5 * scaleX} ${-3 * scaleY} a ${6 * scaleX} ${6 * scaleY} 0 0 1 ${4 * scaleX} ${-10 * scaleY}"/>
      <path d="M ${x + 4.5 * scaleX} ${y + 19 * scaleY} h ${5 * scaleX}"/>
      ${rays}
    </g>`;
  }
  if (kind === "blind") {
    return `<g ${common} fill="none">
      <rect x="${x + scaleX}" y="${y + 2 * scaleY}" width="${16 * scaleX}" height="${16 * scaleY}" rx="${1.5 * s}" fill="${fill}"/>
      <path d="M ${x + scaleX} ${y + 7 * scaleY} h ${16 * scaleX} M ${x + scaleX} ${y + 11 * scaleY} h ${16 * scaleX} M ${x + scaleX} ${y + 15 * scaleY} h ${16 * scaleX}"/>
    </g>`;
  }
  if (kind === "presence") {
    return `<g ${common} fill="none">
      <circle cx="${x + 9 * scaleX}" cy="${y + 6 * scaleY}" r="${4 * s}"/>
      <path d="M ${x + 2.5 * scaleX} ${y + 20 * scaleY} c ${1.4 * scaleX} ${-5 * scaleY} ${11.6 * scaleX} ${-5 * scaleY} ${13 * scaleX} 0"/>
      <path d="M ${x + 15 * scaleX} ${y + 3 * scaleY} l ${3 * scaleX} ${3 * scaleY} l ${5 * scaleX} ${-6 * scaleY}"/>
    </g>`;
  }
  if (kind === "door") {
    return `<g ${common} fill="none">
      <path d="M ${x + 4 * scaleX} ${y + 20 * scaleY} v ${-17 * scaleY} h ${11 * scaleX} v ${17 * scaleY}"/>
      <path d="M ${x + 11 * scaleX} ${y + 11 * scaleY} h ${scaleX}"/>
    </g>`;
  }
  return `<g ${common} fill="none">
    <rect x="${x + 3 * scaleX}" y="${y + 3 * scaleY}" width="${14 * scaleX}" height="${14 * scaleY}" rx="${2 * s}"/>
    <path d="M ${x + 7 * scaleX} ${y + 10 * scaleY} h ${6 * scaleX} M ${x + 10 * scaleX} ${y + 7 * scaleY} v ${6 * scaleY}"/>
  </g>`;
}

type EpaperFlowNode = {
  id: string;
  label: string;
  title: string;
  detail: string;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
};
type EpaperFlowEdge = { id: string; from: EpaperFlowNode; to: EpaperFlowNode; laneX: number; sourceOffset: number; sinkOffset: number; enabled: boolean };
type EpaperFlow = { sources: EpaperFlowNode[]; sinks: EpaperFlowNode[]; edges: EpaperFlowEdge[] };

function renderFlowGraph(flow: EpaperFlow, profile: EpaperProfile, scaleX: number, scaleY: number) {
  const edgeSvg = flow.edges.map((edge) => {
    const fromY = (edge.from.y + edge.from.h / 2 + edge.sourceOffset) * scaleY;
    const toY = (edge.to.y + edge.to.h / 2 + edge.sinkOffset) * scaleY;
    const dash = !edge.enabled && profile.palette === "mono"
      ? ` stroke-dasharray="${1.2 * scaleX} ${4 * scaleX}"`
      : "";
    const d = epaperCurvedPath((edge.from.x + edge.from.w) * scaleX, fromY, edge.laneX * scaleX, edge.to.x * scaleX, toY, scaleX, scaleY);
    const stroke = edge.enabled ? profile.foreground : epaperInactiveLine;
    return `<g>
      <path d="${d}" fill="none" stroke="${profile.background}" stroke-width="${6 * Math.min(scaleX, scaleY)}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="1" stroke-width="${2 * Math.min(scaleX, scaleY)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>
    </g>`;
  }).join("\n    ");
  const nodeSvg = [...flow.sources, ...flow.sinks].map((node) => {
    const fill = node.active ? profile.inverse : profile.background;
    const text = node.active ? profile.inverseText : profile.foreground;
    return `<g>
      <rect x="${node.x * scaleX}" y="${node.y * scaleY}" width="${node.w * scaleX}" height="${node.h * scaleY}" fill="${fill}" stroke="${profile.foreground}" stroke-width="${2 * Math.min(scaleX, scaleY)}"/>
      <rect x="${node.x * scaleX}" y="${node.y * scaleY}" width="${7 * scaleX}" height="${node.h * scaleY}" fill="${profile.accent}"/>
      <text x="${snap((node.x + node.w / 2 + 4) * scaleX)}" y="${snap((node.y + 16) * scaleY)}" fill="${text}" font-family="${epaperFontFamily}" font-size="${snap(10 * Math.min(scaleX, scaleY))}" font-weight="900" text-anchor="middle">${escapeXml(node.title)}</text>
    </g>`;
  }).join("\n    ");
  return `<g>
    ${edgeSvg}
    ${nodeSvg}
  </g>`;
}

function buildEpaperFlow(
  automations: Array<{ enabled: boolean; deps: string[]; outputs: string[]; activeOutputs?: string[] }>,
  activeSources = new Set<string>(),
  activeSinks = new Set<string>(),
  yStart = 100,
): EpaperFlow {
  const sinkIds = uniqueLimited(automations.flatMap((automation) => automation.outputs), 6);
  const sourceIds = prioritizedEpaperSourceIds(automations, sinkIds, 8);
  const sourceGroups = groupEpaperSourceLabels(sourceIds, activeSources);
  const sources = sourceGroups.map((group, index) => ({
    id: `source:${group.key}`,
    label: group.key,
    title: group.title,
    detail: group.detail,
    x: 408,
    y: yStart + index * 31,
    w: 126,
    h: 23,
    active: group.active,
  }));
  const sinks = sinkIds.map((label, index) => ({
    id: `sink:${label}`,
    label,
    ...splitEpaperFlowNodeLabel(label),
    x: 650,
    y: yStart + index * 35,
    w: 126,
    h: 25,
    active: activeSinks.has(label),
  }));
  const sourceByLabel = new Map(sourceGroups.flatMap((group, index) => group.labels.map((label) => [label, sources[index]] as const)));
  const sinkByLabel = new Map(sinks.map((node) => [node.label, node]));
  const rawEdges = automations.flatMap((automation) =>
    automation.deps.flatMap((dep) =>
      automation.outputs.map((output) => ({
        sourceLabel: dep,
        sinkLabel: output,
        enabled: automation.enabled
          && activeSources.has(dep)
          && (automation.activeOutputs ? automation.activeOutputs.includes(output) : true),
      })),
    ),
  );
  const deduped = prioritizeEpaperEdges(uniqueEdges(rawEdges), sinkIds, 14);
  const resolvedEdges = sortEpaperResolvedEdges(uniqueResolvedEpaperEdges(deduped.flatMap((edge) => {
    const from = sourceByLabel.get(edge.sourceLabel);
    const to = sinkByLabel.get(edge.sinkLabel);
    if (!from || !to) return [];
    return [{ ...edge, from, to }];
  })));
  const edgeSlots = epaperResolvedEdgeSlots(resolvedEdges);
  return {
    sources,
    sinks,
    edges: resolvedEdges.map((edge, index) => ({
        id: `${edge.sourceLabel}:${edge.sinkLabel}:${index}`,
        from: edge.from,
        to: edge.to,
        laneX: 552 + (index % 7) * 5,
        sourceOffset: portOffset(edgeSlots.fromIndex.get(edge) ?? 0, edgeSlots.fromCount.get(edge.from.id) ?? 1),
        sinkOffset: portOffset(edgeSlots.toIndex.get(edge) ?? 0, edgeSlots.toCount.get(edge.to.id) ?? 1),
        enabled: edge.enabled,
    })),
  };
}

function prioritizeEpaperEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }>, sinkIds: string[], limit: number) {
  const prioritized: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }> = [];
  const edgesBySink = sinkIds.map((sink) => edges.filter((edge) => edge.sinkLabel === sink));
  for (let index = 0; index < limit; index += 1) {
    for (const sinkEdges of edgesBySink) {
      const edge = sinkEdges[index];
      if (edge) prioritized.push(edge);
    }
  }
  return uniqueEdges([...prioritized, ...edges]).slice(0, limit);
}

function epaperSourceActive(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["", "off", "closed", "clear", "idle", "false", "unknown", "unavailable"].includes(value.toLowerCase());
  return false;
}

function expandEpaperSourceDeps(
  dep: string,
  signalById: Map<string, Snapshot["signals"][number]>,
  sourceById: Map<string, SnapshotSource>,
  transitiveDepActiveById = new Map<string, boolean>(),
  seen = new Set<string>(),
): EpaperExpandedDep[] {
  if (dep === "time.tick" || seen.has(dep)) return [];
  const signal = signalById.get(dep);
  if (!signal) {
    return sourceById.has(dep)
      ? [{ source: dep, active: epaperSourceActive(sourceById.get(dep)?.value) }]
      : [];
  }
  seen.add(dep);
  const gateStates = signal.deps
    .filter((signalDep) => !signalById.has(signalDep) && !sourceById.has(signalDep) && signalDep !== "time.tick")
    .map((signalDep) => transitiveDepActiveById.get(signalDep))
    .filter((active): active is boolean => typeof active === "boolean");
  const gateActive = gateStates.length ? gateStates.some(Boolean) : true;
  return signal.deps.flatMap((signalDep) =>
    expandEpaperSourceDeps(signalDep, signalById, sourceById, transitiveDepActiveById, new Set(seen))
      .map((expanded) => ({ ...expanded, active: expanded.active && gateActive })),
  );
}

function uniqueEpaperDepStates(values: EpaperExpandedDep[], limit: number): EpaperExpandedDep[] {
  const activeBySource = new Map<string, boolean>();
  for (const value of values) {
    activeBySource.set(value.source, Boolean(activeBySource.get(value.source)) || value.active);
  }
  return [...activeBySource.entries()].slice(0, limit).map(([source, active]) => ({ source, active }));
}

function epaperTransitiveDepActivity(snapshot: Snapshot, now: number) {
  return new Map((snapshot.pulses ?? []).map((pulse) => [
    pulse.source,
    now < pulse.lastTriggeredAt + pulse.duration,
  ]));
}

function inferEpaperRuleOutputs(ruleName: string, layers: Snapshot["layers"]) {
  const matched = layers.flatMap((layer) => {
    const surfaced = layer.surfaced;
    if (!surfaced) return [];
    const output = surfaced.output as { reason?: unknown; writer?: unknown };
    return output.reason === ruleName || output.writer === ruleName ? [layer.target] : [];
  });
  if (matched.length) return matched;
  return layers.flatMap((layer) => layer.surfaced?.layer === "automation" ? [layer.target] : []);
}

function epaperRuleOutputWrites(rule: Snapshot["rules"][number], layers: Snapshot["layers"]) {
  const writes = "outputWrites" in rule && Array.isArray(rule.outputWrites)
    ? rule.outputWrites as Array<{ target: string; hasOutput: boolean }>
    : [];
  if (writes.length) return writes;
  const outputs = rule.outputs?.length ? rule.outputs : inferEpaperRuleOutputs(rule.name, layers);
  return outputs.map((target) => ({
    target,
    hasOutput: ruleHasEpaperAutomationOpinion(rule.name, layers.find((layer) => layer.target === target)),
  }));
}

function ruleHasEpaperAutomationOpinion(ruleName: string, layer: SnapshotLayer | undefined) {
  const automationLayer = layer?.layers?.find((item) => item.layer === "automation");
  if (!automationLayer) return layer?.surfaced?.layer === "automation" && layer.surfaced.output.state !== null;
  if (automationLayer.items?.length) {
    return automationLayer.items.some((item) => item.key === ruleName || item.output.writer === ruleName);
  }
  return automationLayer.output.writer === ruleName || automationLayer.output.reason === ruleName;
}

function eventActionHasEpaperOpinion(layer: SnapshotLayer | undefined) {
  return Boolean(
    layer?.layers?.some((item) => item.layer !== "automation" && item.layer !== "default")
    || (layer?.surfaced && layer.surfaced.layer !== "automation" && layer.surfaced.layer !== "default"),
  );
}

function epaperVisibleFlowOutputs(outputs: string[], targetById: Map<string, SnapshotTarget>) {
  return outputs.filter((output) => {
    const epaper = targetById.get(output)?.capabilities?.epaper as { excludeFromFlow?: unknown } | undefined;
    return epaper?.excludeFromFlow !== true;
  });
}

function epaperOutputActive(state: unknown) {
  if (state == null) return false;
  if (typeof state === "boolean") return state;
  if (typeof state !== "object") return epaperSourceActive(state);
  const data = state as Record<string, unknown>;
  if ("power" in data) return data.power === "on" || data.power === true;
  if ("position" in data) return data.position === "open" || (typeof data.position === "number" && data.position < 95);
  if ("motion" in data) return data.motion !== "stop";
  return false;
}

function prioritizedEpaperSourceIds(automations: Array<{ deps: string[]; outputs: string[] }>, sinkIds: string[], limit: number) {
  const prioritized: string[] = [];
  const depsBySink = sinkIds.map((sink) => uniqueLimited(
    [...automations.filter((automation) => automation.outputs.includes(sink)).flatMap((automation) => automation.deps)]
      .sort(compareEpaperSourcePriority),
    limit,
  ));
  for (let index = 0; index < limit; index += 1) {
    for (const deps of depsBySink) {
      const dep = deps[index];
      if (dep) prioritized.push(dep);
    }
  }
  return uniqueLimited([...prioritized, ...automations.flatMap((automation) => automation.deps)], limit);
}

function compareEpaperSourcePriority(left: string, right: string) {
  return epaperSourcePriority(left) - epaperSourcePriority(right);
}

function epaperSourcePriority(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes(".paddle.") || lower.includes(".button.")) return 0;
  if (lower.endsWith(".presence") || lower.endsWith(".open") || lower.includes(".door.")) return 1;
  if (lower.endsWith(".activelayer")) return 2;
  return 3;
}

function groupEpaperSourceLabels(labels: string[], activeSources: Set<string>) {
  const groups = new Map<string, { key: string; labels: string[]; title: string; detailParts: string[]; active: boolean }>();
  for (const label of labels) {
    const split = splitEpaperFlowNodeLabel(label);
    const rawDetail = epaperFlowNodeRawDetail(label);
    const shouldGroup = split.title.toLowerCase().startsWith("presence") || rawDetail === "activeLayer" || isEpaperEventSourceDetail(rawDetail);
    const key = shouldGroup ? `source:${split.title}` : label;
    const group = groups.get(key) ?? { key, labels: [], title: split.title, detailParts: [], active: false };
    group.labels.push(label);
    group.active ||= activeSources.has(label);
    const groupedDetail = epaperGroupedSourceDetail(rawDetail);
    if (groupedDetail) group.detailParts.push(groupedDetail);
    else if (split.detail) group.detailParts.push(split.detail);
    else if (shouldGroup && rawDetail && !isRedundantEpaperNodeDetail(split.title, rawDetail)) group.detailParts.push(rawDetail);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    labels: group.labels,
    title: group.title,
    detail: truncateMiddle([...new Set(group.detailParts)].join(" / "), 26),
    active: group.active,
  }));
}

function epaperFlowNodeRawDetail(label: string) {
  const [, ...rest] = label.split(".");
  return rest.join(".");
}

function isEpaperEventSourceDetail(detail: string) {
  return detail.startsWith("paddle.") || detail.startsWith("button.");
}

function epaperGroupedSourceDetail(detail: string) {
  const parts = detail.split(".");
  if (parts[0] === "paddle" && parts[1]) return `paddle ${parts[1]}`;
  if (parts[0] === "button" && parts[1]) return `button ${parts[1]}`;
  return "";
}

function splitEpaperFlowNodeLabel(label: string) {
  const [first, ...rest] = label.split(".");
  if (!rest.length) {
    return {
      title: truncateMiddle(label, 16),
      detail: "",
    };
  }
  const detail = rest.join(".");
  if (isRedundantEpaperNodeDetail(first, detail)) {
    return {
      title: truncateMiddle(first || label, 16),
      detail: "",
    };
  }
  return {
    title: truncateMiddle(first || label, 14),
    detail: truncateMiddle(detail, 26),
  };
}

function isRedundantEpaperNodeDetail(title: string, detail: string) {
  const normalizedTitle = title.toLowerCase();
  const normalizedDetail = detail.toLowerCase();
  if (normalizedTitle === normalizedDetail) return true;
  return normalizedDetail === "presence" && normalizedTitle.startsWith("presence");
}

function epaperCurvedPath(sourceX: number, sourceY: number, laneX: number, targetX: number, targetY: number, scaleX: number, scaleY: number) {
  const direction = targetY >= sourceY ? 1 : -1;
  const verticalGap = Math.abs(targetY - sourceY);
  const horizontalIn = Math.max(0, laneX - sourceX);
  const horizontalOut = Math.max(0, targetX - laneX);
  const c2 = Math.max(2 * scaleX, Math.min(18 * scaleX, horizontalIn / 2, verticalGap / 2));
  const c1 = Math.max(2 * scaleX, Math.min(18 * scaleX, horizontalOut / 2, verticalGap / 2));
  if (verticalGap < 4 * scaleY || c1 < 3 * scaleX || c2 < 3 * scaleX) return `M ${sourceX} ${sourceY} L ${laneX} ${sourceY} L ${laneX} ${targetY} L ${targetX} ${targetY}`;
  const sourceSweep = direction > 0 ? 1 : 0;
  const targetSweep = direction > 0 ? 0 : 1;
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${laneX - c2} ${sourceY}`,
    `A ${c2} ${c2} 90 0 ${sourceSweep} ${laneX} ${sourceY + direction * c2}`,
    `L ${laneX} ${targetY - direction * c1}`,
    `A ${c1} ${c1} 90 0 ${targetSweep} ${laneX + c1} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

function uniqueLimited(values: string[], limit: number) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function uniqueEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }>) {
  const seen = new Map<string, { sourceLabel: string; sinkLabel: string; enabled: boolean }>();
  for (const edge of edges) {
    const key = `${edge.sourceLabel}->${edge.sinkLabel}`;
    const existing = seen.get(key);
    seen.set(key, { ...edge, enabled: edge.enabled || Boolean(existing?.enabled) });
  }
  return [...seen.values()];
}

function uniqueResolvedEpaperEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean; from: EpaperFlowNode; to: EpaperFlowNode }>) {
  const seen = new Map<string, { sourceLabel: string; sinkLabel: string; enabled: boolean; from: EpaperFlowNode; to: EpaperFlowNode }>();
  for (const edge of edges) {
    const key = `${edge.from.id}->${edge.to.id}`;
    const existing = seen.get(key);
    seen.set(key, { ...edge, enabled: edge.enabled || Boolean(existing?.enabled) });
  }
  return [...seen.values()];
}

function sortEpaperResolvedEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean; from: EpaperFlowNode; to: EpaperFlowNode }>) {
  return [...edges].sort((left, right) =>
    (left.from.y + left.from.h / 2) - (right.from.y + right.from.h / 2)
    || (left.to.y + left.to.h / 2) - (right.to.y + right.to.h / 2)
    || left.sourceLabel.localeCompare(right.sourceLabel)
    || left.sinkLabel.localeCompare(right.sinkLabel),
  );
}

function epaperResolvedEdgeSlots(edges: Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>) {
  const byFrom = new Map<string, Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>>();
  const byTo = new Map<string, Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>>();
  for (const edge of edges) {
    const fromList = byFrom.get(edge.from.id) ?? [];
    fromList.push(edge);
    byFrom.set(edge.from.id, fromList);
    const toList = byTo.get(edge.to.id) ?? [];
    toList.push(edge);
    byTo.set(edge.to.id, toList);
  }
  for (const list of byFrom.values()) {
    list.sort((left, right) => (left.to.y + left.to.h / 2) - (right.to.y + right.to.h / 2));
  }
  for (const list of byTo.values()) {
    list.sort((left, right) => (left.from.y + left.from.h / 2) - (right.from.y + right.from.h / 2));
  }
  const fromIndex = new Map<(typeof edges)[number], number>();
  const toIndex = new Map<(typeof edges)[number], number>();
  const fromCount = new Map<string, number>();
  const toCount = new Map<string, number>();
  for (const [id, list] of byFrom) {
    fromCount.set(id, list.length);
    list.forEach((edge, index) => fromIndex.set(edge, index));
  }
  for (const [id, list] of byTo) {
    toCount.set(id, list.length);
    list.forEach((edge, index) => toIndex.set(edge, index));
  }
  return { fromIndex, fromCount, toIndex, toCount };
}

function countResolvedEdgesForNode(edges: Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>, nodeId: string, key: "from" | "to") {
  return edges.filter((edge) => edge[key].id === nodeId).length;
}

function indexForResolvedEdgeNode(edges: Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>, nodeId: string, key: "from" | "to", edgeIndex: number) {
  return edges.slice(0, edgeIndex + 1).filter((edge) => edge[key].id === nodeId).length - 1;
}

function countEdgesForLabel(edges: Array<{ sourceLabel: string; sinkLabel: string }>, label: string, key: "sourceLabel" | "sinkLabel") {
  return edges.filter((edge) => edge[key] === label).length;
}

function indexForEdgeLabel(edges: Array<{ sourceLabel: string; sinkLabel: string }>, label: string, key: "sourceLabel" | "sinkLabel", edgeIndex: number) {
  return edges.slice(0, edgeIndex + 1).filter((edge) => edge[key] === label).length - 1;
}

function portOffset(index: number, total: number) {
  if (total <= 1) return 0;
  return (index - (total - 1) / 2) * 4;
}

function renderEmptyText(textX: number, textY: number, text: string, profile: EpaperProfile, scaleX: number, scaleY: number) {
  return `<text x="${snap(textX * scaleX)}" y="${snap(textY * scaleY)}" fill="${profile.foreground}" font-family="${epaperFontFamily}" font-size="${snap(15 * Math.min(scaleX, scaleY))}" font-weight="900">${escapeXml(text)}</text>`;
}

function snap(value: number) {
  return Math.round(value);
}

function epaperCacheKey(options: EpaperRenderOptions & { room: string; title: string; display: EpaperDisplayDefinition }) {
  const profile = resolveEpaperProfile(options);
  return stableStringify({
    display: options.display.id,
    room: options.room,
    title: options.title,
    profile: profile.id,
    width: profile.width,
    height: profile.height,
    palette: profile.palette,
  });
}

function epaperRenderFingerprint(
  snapshot: Snapshot,
  options: EpaperRenderOptions & { room: string; title: string; display: EpaperDisplayDefinition },
  now: number,
) {
  const roomSnapshot = filterSnapshot(snapshot, options.room);
  const sourceById = new Map(roomSnapshot.sources.map((source) => [source.source, source]));
  const signalById = new Map(snapshot.signals.map((signal) => [signal.id, signal]));
  const transitiveDepActiveById = epaperTransitiveDepActivity(snapshot, now);
  const layerByTarget = new Map(roomSnapshot.layers.map((layer) => [layer.target, layer]));
  const matter = snapshot.providers.find((provider) => provider.name === "matter") as MatterProviderSnapshot;
  const bindingByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const statCards = epaperStats(snapshot, options.display.stats ?? [], now);
  return stableStringify({
    stats: statCards,
    devices: visibleDeviceTargets(roomSnapshot.targets, options.display).map((target) => {
      const layer = layerByTarget.get(target.target);
      const binding = bindingByKey.get(target.key) ?? bindingByKey.get(target.target);
      return {
        target: target.target,
        key: target.key,
        label: binding?.label ?? target.key,
        available: binding?.available,
        statusSources: epaperStatusSourceIds(target).map((source) => [source, sourceById.get(source)?.value]),
        status: layer?.surfaced?.output.state,
        layer: layer?.surfaced?.layer,
      };
    }),
    rules: roomSnapshot.rules.map((rule) => ({
      name: rule.name,
      enabled: rule.enabled,
      deps: rule.deps,
      outputs: rule.outputs,
      outputWrites: "outputWrites" in rule ? rule.outputWrites : undefined,
      depValues: rule.deps
        .flatMap((dep) => expandEpaperSourceDeps(dep, signalById, sourceById, transitiveDepActiveById))
        .map((dep) => [dep.source, sourceById.get(dep.source)?.value ?? signalById.get(dep.source)?.value, dep.active]),
    })),
    events: (roomSnapshot.eventActions ?? []).map((action) => ({
      name: action.name,
      event: action.event,
      outputs: action.outputs,
      active: Boolean(action.lastRunAt && now - action.lastRunAt <= 5 * 60 * 1000),
    })),
    signals: roomSnapshot.signals.map((signal) => ({
      id: signal.id,
      value: signal.value,
      deps: signal.deps,
    })),
    layers: roomSnapshot.layers.map((layer) => ({
      target: layer.target,
      surfaced: layer.surfaced
        ? {
            layer: layer.surfaced.layer,
            state: layer.surfaced.output.state,
            reason: layer.surfaced.output.reason,
          }
        : undefined,
    })),
  });
}

function epaperStatusSourceIds(target: SnapshotTarget) {
  return [
    target.display?.status?.source,
    `${target.key}.status`,
    `${target.key}.power`,
    `${target.key}.displayStatus`,
    `${target.key}.presence`,
    `${target.key}.open`,
    `${target.key}.position`,
  ].filter((source): source is string => Boolean(source));
}

function epaperStats(snapshot: Snapshot, stats: EpaperStatDefinition[], now: number) {
  const sourceById = new Map(snapshot.sources.map((source) => [source.source, source]));
  const signalById = new Map(snapshot.signals.map((signal) => [signal.id, signal]));
  return stats.map((stat) => {
    const value = formatEpaperStatValue(stat, stat.source ? sourceById.get(stat.source)?.value : signalById.get(stat.signal ?? "")?.value);
    return {
      label: stat.label,
      value: throttledEpaperStatValue(stat, value, now),
    };
  });
}

function formatEpaperStatValue(stat: EpaperStatDefinition, value: unknown) {
  if (stat.format === "day-night") return typeof value === "boolean" ? (value ? "DAY" : "NIGHT") : "--";
  if (typeof value !== "number") return "--";
  const formatted = stat.format === "integer" ? String(Math.round(value)) : String(value);
  return `${formatted}${stat.unit ?? ""}`;
}

function throttledEpaperStatValue(stat: EpaperStatDefinition, value: string, now: number) {
  if (!stat.minUpdateMs) return value;
  const key = stat.source ?? stat.signal ?? stat.label;
  const cached = statValueCache.get(key);
  if (!cached || now - cached.updatedAt >= stat.minUpdateMs) {
    statValueCache.set(key, { value, updatedAt: now });
    return value;
  }
  return cached.value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortStable(item)]));
}

function sanitizeDimension(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(120, Math.min(2400, Math.round(value)));
}

export function parseEpaperRenderOptions(query: Record<string, unknown>): EpaperRenderOptions {
  const width = parseNumberQuery(query.width ?? query.w);
  const height = parseNumberQuery(query.height ?? query.h);
  const palette = parsePaletteQuery(query.palette ?? query.color ?? query.colors);
  return {
    profile: parseStringQuery(query.profile ?? query.display),
    room: parseStringQuery(query.room),
    title: parseStringQuery(query.title),
    width,
    height,
    palette,
  };
}

function parseNumberQuery(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringQuery(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function parsePaletteQuery(value: unknown): EpaperPalette | undefined {
  const raw = parseStringQuery(value)?.toLowerCase();
  if (raw === "mono" || raw === "monochrome" || raw === "1bit" || raw === "bw") return "mono";
  if (raw === "grayscale" || raw === "gray" || raw === "grey") return "grayscale";
  if (raw === "color" || raw === "colour") return "color";
  return undefined;
}

function filterSnapshot(snapshot: Snapshot, room: string) {
  const inRoom = (id: string) => roomOf(id) === room;
  return {
    ...snapshot,
    sources: snapshot.sources.filter((source) => inRoom(source.source)),
    signals: snapshot.signals.filter((signal) => inRoom(signal.id)),
    targets: snapshot.targets.filter((target) => inRoom(target.target)),
    rules: snapshot.rules.filter((rule) => inRoom(rule.name)),
    layers: snapshot.layers.filter((layer) => inRoom(layer.target)),
    events: snapshot.events.filter(inRoom),
    eventActions: (snapshot.eventActions ?? []).filter((action) => inRoom(action.name)),
  };
}

function visibleDeviceTargets(targets: Snapshot["targets"], display?: EpaperDisplayDefinition) {
  const hiddenTargets = new Set(display?.hiddenTargets ?? []);
  return targets.filter((target) => !hiddenTargets.has(target.target) && !target.target.includes(".endpoint.") && !target.target.endsWith(".statusLed"));
}

function roomOf(id: string) {
  return id.split(".")[0] ?? id;
}

function deviceStatus(target: SnapshotTarget, sourceById: Map<string, SnapshotSource>, layer?: SnapshotLayer) {
  const source = target.display?.status?.source ? sourceById.get(target.display.status.source) : fallbackStatusSource(target, sourceById);
  const raw = source?.value ?? target.display?.status?.value;
  const state = layer?.surfaced?.output.state;
  const layered = state && typeof state === "object" ? state as Record<string, unknown> : undefined;
  if (layered) {
    if (target.capabilities?.position || target.capabilities?.commands) {
      if (layered.motion === "stop") return { label: "stopped", tone: "idle", since: layer?.surfaced?.since };
      if (layered.position === "open") return { label: "opening", tone: "opening", since: layer?.surfaced?.since };
      if (layered.position === "closed") return { label: "closing", tone: "closing", since: layer?.surfaced?.since };
    }
    if ("power" in layered) {
      return layered.power === "off" || layered.power === false
        ? { label: "off", tone: "off", since: source?.since ?? layer?.surfaced?.since }
        : { label: "on", tone: "on", since: source?.since ?? layer?.surfaced?.since };
    }
  }
  if (target.capabilities?.buttons || target.capabilities?.events) return undefined;
  if (raw === undefined) return undefined;
  if (source?.property === "presence") return raw ? { label: "active", tone: "active", since: source.since } : { label: "clear", tone: "idle", since: source.since };
  if (source?.property === "open") return raw ? { label: "open", tone: "open", since: source.since } : { label: "closed", tone: "closed", since: source.since };
  if (typeof raw === "boolean") return raw ? { label: "on", tone: "on", since: source?.since } : { label: "off", tone: "off", since: source?.since };
  if (typeof raw === "number" && target.capabilities?.position) {
    if (raw <= 5) return { label: "open", tone: "open", since: source?.since };
    if (raw >= 95) return { label: "closed", tone: "closed", since: source?.since };
    return { label: `${Math.round(raw)}%`, tone: "active", since: source?.since };
  }
  return { label: formatValue(raw), tone: "unknown", since: source?.since };
}

function fallbackStatusSource(target: SnapshotTarget, sourceById: Map<string, SnapshotSource>) {
  return [
    `${target.key}.status`,
    `${target.key}.power`,
    `${target.key}.displayStatus`,
    `${target.key}.presence`,
    `${target.key}.open`,
    `${target.key}.position`,
  ].map((source) => sourceById.get(source)).find(Boolean);
}

function deviceBattery(target: SnapshotTarget, sourceById: Map<string, SnapshotSource>) {
  const value = target.display?.battery?.source
    ? sourceById.get(target.display.battery.source)?.value ?? target.display.battery.value
    : target.display?.battery?.value;
  if (typeof value !== "number") return { label: "-", tone: "unknown" };
  return { label: value <= 100 ? `${Math.round(value)}%` : `${value.toFixed(1)}V`, tone: value <= 20 ? "warn" : "ok" };
}

function deviceMetrics(target: SnapshotTarget, sourceById: Map<string, SnapshotSource>) {
  return (target.display?.metrics ?? []).flatMap((metric) => {
    const value = sourceById.get(metric.source)?.value ?? metric.value;
    if (typeof value !== "number" && typeof value !== "string") return [];
    const formatted = typeof value === "number" ? `${Math.round(value)}${metric.unit ?? ""}` : `${value}${metric.unit ?? ""}`;
    return [{ label: `${metric.label}: ${formatted}`, tone: "ok" }];
  });
}

function deviceDisplayLabel(label: string, target: SnapshotTarget, room: string) {
  return stripRoomPrefix(label, room) || stripRoomPrefix(target.key, room) || label;
}

function epaperFlowLabel(id: string, room: string, length: number) {
  return truncateMiddle(stripRoomPrefix(id, room), length);
}

function stripRoomPrefix(value: string, room: string) {
  const prefixes = [...new Set([room, humanRoomName(room), room.replace(/([a-z])([A-Z])/g, "$1 $2"), room.replace(/[-_]+/g, " ")])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    const trimmed = stripPrefix(value, prefix);
    if (trimmed !== value) return trimmed;
  }
  return value;
}

function stripPrefix(value: string, prefix: string) {
  const candidate = value.trimStart();
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return value;
  const next = candidate[prefix.length];
  const previous = candidate[prefix.length - 1];
  const hasBoundary = next === undefined || /[\s._:-]/.test(next) || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(next));
  if (!hasBoundary) return value;
  return candidate.slice(prefix.length).replace(/^[\s._:-]+/, "").trim() || value;
}

function matterHealth(matter: MatterProviderSnapshot, binding: MatterResolvedBinding | undefined) {
  if (matter?.status?.enabled === false) return { label: "disabled", tone: "muted" };
  if (!binding) return { label: "unresolved", tone: "warn" };
  if (binding.available === true) return { label: "online", tone: "ok" };
  if (binding.available === false) return { label: "offline", tone: "bad" };
  return { label: "unknown", tone: "muted" };
}

function deviceProviderHealth(target: SnapshotTarget, matter: MatterProviderSnapshot, binding: MatterResolvedBinding | undefined) {
  return target.provider === "matter" ? matterHealth(matter, binding) : { label: target.provider, tone: "ok" };
}

function matterProviderHealth(status: MatterStatus | null | undefined, now: number) {
  if (status?.enabled === false) return { label: "Disabled" };
  if (!status?.connected) return { label: "Offline" };
  if (status.lastMessageAt && now - status.lastMessageAt > 180_000) return { label: "Stale" };
  return { label: "Live" };
}

function matterAvailabilityCounts(status?: MatterStatus | null) {
  if (!status || status.enabled === false) return null;
  const availableNodeIds = new Set((status.resolved ?? []).filter((binding) => binding.available === true).map((binding) => binding.nodeId));
  return { available: availableNodeIds.size, total: status.nodeCount ?? status.resolved?.length ?? 0 };
}

function humanRoomName(room: string) {
  return room.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatRunTime(value?: number) {
  if (!value) return "never";
  const minutes = Math.max(0, Math.floor((floorToMinute(Date.now()) - floorToMinute(value)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatForDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatEpaperTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(floorToMinute(value));
}

function floorToMinute(value: number) {
  return Math.floor(value / 60_000) * 60_000;
}

function formatValue(value: unknown) {
  if (value === undefined) return "unknown";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function truncateText(value: string, length: number) {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}...`;
}

function truncateMiddle(value: string, length: number) {
  if (value.length <= length) return value;
  const keep = Math.max(2, Math.floor((length - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function escapeXml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
