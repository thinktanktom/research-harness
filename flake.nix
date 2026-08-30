{
  description = "research-harness dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "research-harness dev shell — node $(node --version)"
            if [ ! -d node_modules ]; then
              echo "Run: npm install"
            fi
          '';
        };
      });
}
