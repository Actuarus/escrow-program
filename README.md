# Programme de séquestre ACTUARUS

Code source du programme Solana de séquestre utilisé par [ACTUARUS](https://actuarus.io).

| | |
|---|---|
| Adresse (mainnet et devnet) | `DNwHyasEkHQYfswjPAxvnudCgN1gdZuHA2y2TSp8GVXE` |
| Autorité de mise à jour (mainnet) | `A1tV46Z2AP128uQqaubaVG75aMaWu6V7FfmAU4eWftyx`, vault du multisig Squads `NNpfpp7ugNcUAzVVEBnXwS7eajs64TpNaqbdwPacm5T` (2 signatures sur 3, délai de 48 h) |
| Framework | Anchor 0.32.1 |
| Contact sécurité | contact@actuarus.io, voir [security.txt](https://actuarus.io/.well-known/security.txt) |

## Fonctionnement

Séquestre en multisignature 2 sur 3 : l'acheteur, le vendeur et l'arbitre (multisig de la plateforme) votent
« libérer » ou « rembourser » ; au deuxième vote identique, les fonds partent. Personne ne peut déplacer les fonds
seul. Dépôts en SOL, USDC ou EURC. Une période de garantie d'au moins 24 heures permet le versement au vendeur sans
second vote, sauf litige de l'acheteur. Le détail est en tête de `programs/anchor-workspace/src/lib.rs`.

## Build

Le réseau doit être choisi explicitement :

```sh
anchor build -- --features mainnet   # ou --features devnet
```

Build vérifiable (reproductible, comparable au programme déployé) :

```sh
solana-verify build --library-name anchor_workspace -- --features mainnet
solana-verify get-program-hash -u mainnet-beta DNwHyasEkHQYfswjPAxvnudCgN1gdZuHA2y2TSp8GVXE
```

`Cargo.lock` fige les versions des dépendances : il est indispensable pour retrouver la même empreinte.

## Tests

Les tests (`tests/`) tournent sur un validateur local avec un build `--features test-treasury`, qui remplace le
multisig de la plateforme par une trésorerie de test. La clé de cette trésorerie n'est pas publiée : les tests ne
s'exécutent donc pas tels quels depuis ce dépôt.

## Licence

Apache 2.0, voir [LICENSE](LICENSE). Copyright 2026 ACTUARUS.
