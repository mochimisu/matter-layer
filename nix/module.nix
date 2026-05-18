self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.matter-layer;
  format = pkgs.formats.json {};
  bindingsFile = format.generate "matter-layer-bindings.json" cfg.bindings;
in {
  options.services.matter-layer = {
    enable = lib.mkEnableOption "Matter Layer automation runtime and web UI";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.matter-layer.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "matter-layer package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "matter-layer";
      description = "User that runs matter-layer.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "matter-layer";
      description = "Group that runs matter-layer.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "HTTP port for the API and web UI.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the service port in the firewall.";
    };

    matterWsUrl = lib.mkOption {
      type = lib.types.str;
      default = "ws://127.0.0.1:5580/ws";
      description = "Matter server websocket URL.";
    };

    matterEnabled = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Connect to the Matter websocket provider.";
    };

    dryRun = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Evaluate rules without applying Matter commands.";
    };

    rulesModule = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        TypeScript module exporting `defineRules({ devices, rules })`.
        The module can import helpers from `matter-layer/rules` and
        `matter-layer/devices`.
      '';
    };

    bindings = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          label = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Matter NodeLabel used to resolve this logical device key.";
          };
          mac = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Optional Matter MAC address used to resolve this logical device key.";
          };
        };
      });
      default = {};
      description = "Logical device key to Matter identity bindings.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = {};
      description = "Additional environment variables for the service.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional systemd EnvironmentFile for secrets or local overrides.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.group} = {};
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = "/var/lib/matter-layer";
      createHome = true;
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [cfg.port];

    systemd.services.matter-layer = {
      description = "Matter Layer automation runtime and web UI";
      wantedBy = ["multi-user.target"];
      after = ["network-online.target"];
      wants = ["network-online.target"];

      environment =
        {
          HOME = "/var/lib/matter-layer";
          MATTER_LAYER_PORT = toString cfg.port;
          MATTER_LAYER_MATTER_WS_URL = cfg.matterWsUrl;
          MATTER_LAYER_MATTER_ENABLED = if cfg.matterEnabled then "1" else "0";
          MATTER_LAYER_DRY_RUN = if cfg.dryRun then "1" else "0";
          MATTER_LAYER_BINDINGS_FILE = bindingsFile;
        }
        // lib.optionalAttrs (cfg.rulesModule != null) {
          MATTER_LAYER_RULES_MODULE = toString cfg.rulesModule;
        }
        // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "/var/lib/matter-layer";
        ExecStart = "${cfg.package}/bin/matter-layer";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "always";
        RestartSec = 5;
      };
    };
  };
}
