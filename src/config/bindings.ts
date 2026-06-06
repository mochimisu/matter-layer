export type MatterBinding = {
  label?: string;
  unique_id?: string;
  mac?: string;
};

export function matterLabelForKey(bindings: Record<string, MatterBinding>, key: string) {
  return bindings[parentTarget(key)]?.label;
}

export function matterMacForKey(bindings: Record<string, MatterBinding>, key: string) {
  return bindings[parentTarget(key)]?.mac;
}

export function matterUniqueIdForKey(bindings: Record<string, MatterBinding>, key: string) {
  return bindings[parentTarget(key)]?.unique_id;
}

function parentTarget(key: string) {
  return key.replace(/\.endpoint\.\d+\..*$/, "");
}
