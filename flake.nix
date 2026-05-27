{
  description = "Matter Layer automation runtime and web UI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.buildNpmPackage {
        pname = "matter-layer";
        version = "0.0.0";
        src = ./.;

        npmDepsHash = "sha256-5WKnKVs4VY+P5qIjvmYIS26NWe5bPxSZ4GjVWh60lfY=";
        npmBuildScript = "web:build";

        installPhase = ''
          runHook preInstall

          appDir="$out/lib/matter-layer"
          mkdir -p "$appDir" "$out/bin"
          cp -R package.json package-lock.json tsconfig.json src web dist node_modules "$appDir"/

          makeWrapper ${pkgs.lib.getExe pkgs.tsx} "$out/bin/matter-layer" \
            --chdir "$appDir" \
            --add-flags "$appDir/src/server.ts" \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.nodejs_24]}

          runHook postInstall
        '';

        nativeBuildInputs = [pkgs.makeWrapper];
      };
    });

    nixosModules.default = import ./nix/module.nix self;
  };
}
