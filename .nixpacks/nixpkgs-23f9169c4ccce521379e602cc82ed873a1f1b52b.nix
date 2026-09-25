{ }:

let pkgs = import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/23f9169c4ccce521379e602cc82ed873a1f1b52b.tar.gz") { overlays = [ (import (builtins.fetchTarball "https://github.com/railwayapp/nix-npm-overlay/archive/main.tar.gz")) ]; };
in with pkgs;
  let
    APPEND_LIBRARY_PATH = "${lib.makeLibraryPath [ gcc-unwrapped ] }";
    myLibraries = writeText "libraries" ''
      export LD_LIBRARY_PATH="${APPEND_LIBRARY_PATH}:$LD_LIBRARY_PATH"
      
    '';
  in
    buildEnv {
      name = "23f9169c4ccce521379e602cc82ed873a1f1b52b-env";
      paths = [
        (runCommand "23f9169c4ccce521379e602cc82ed873a1f1b52b-env" { } ''
          mkdir -p $out/etc/profile.d
          cp ${myLibraries} $out/etc/profile.d/23f9169c4ccce521379e602cc82ed873a1f1b52b-env.sh
        '')
        nodejs_24 pnpm-9_x
      ];
    }
