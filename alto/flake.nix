{
  description = "Alto development environment and build command wrappers";

  # This branch retains x86_64-darwin support, matching build.sh.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs =
    { self, nixpkgs, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
      commandFor =
        pkgs: name: command:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = with pkgs; [
            bash
            coreutils
            curl
            findutils
            git
            gnugrep
            gnutar
            nodejs_22
            perl
            xz
          ];
          text = ''
            project_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
            if [[ -z "$project_root" || ! -f "$project_root/package.json" ]]; then
              echo "Run this command from an Alto checkout." >&2
              exit 1
            fi

            cd "$project_root"
            ${command}
          '';
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          build-ghostty = commandFor pkgs "alto-build-ghostty" ''
            if [[ "$(uname -s)" != "Darwin" ]]; then
              echo "Ghostty native support can only be built on macOS." >&2
              exit 1
            fi

            for tool in xcode-select xcodebuild xcrun; do
              if ! command -v "$tool" >/dev/null; then
                echo "Missing $tool. Install full Xcode and select it with xcode-select." >&2
                exit 1
              fi
            done

            exec npm run build:ghostty
          '';

          check = commandFor pkgs "alto-check" ''
            if [[ ! -d node_modules ]]; then
              echo "node_modules is missing. Run npm install inside nix develop first." >&2
              exit 1
            fi

            exec npm run check
          '';
        }
      );

      apps = forAllSystems (system: {
        build-ghostty = {
          type = "app";
          program = "${self.packages.${system}.build-ghostty}/bin/alto-build-ghostty";
          meta.description = "Build Alto's native Ghostty bridge with the existing build script";
        };
        check = {
          type = "app";
          program = "${self.packages.${system}.check}/bin/alto-check";
          meta.description = "Run Alto's type checks, tests, and production build";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              bashInteractive
              coreutils
              curl
              findutils
              git
              gnugrep
              gnutar
              nodejs_22
              perl
              xz
            ];

            shellHook = ''
              echo "Alto development shell (Node $(node --version))"
              if [[ "$(uname -s)" == "Darwin" ]] && ! command -v xcrun >/dev/null; then
                echo "warning: full Xcode is required for the native Ghostty build" >&2
              fi
            '';
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
