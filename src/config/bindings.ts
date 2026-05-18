export type MatterBinding = {
  label?: string;
  mac?: string;
};

export function matterLabelForKey(bindings: Record<string, MatterBinding>, key: string) {
  return bindings[parentTarget(key)]?.label;
}

export function matterMacForKey(bindings: Record<string, MatterBinding>, key: string) {
  return bindings[parentTarget(key)]?.mac;
}

function parentTarget(key: string) {
  return key.replace(/\.endpoint\.\d+\..*$/, "");
}
