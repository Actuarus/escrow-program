import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAccount,
  createAssociatedTokenAccount,
  setAuthority,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { expect, AssertionError } from "chai";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY, TREASURY_KEYPAIR } from "./treasury";

// Séquestre en jetons (2 sur 3). Sur le validateur local, USDC et EURC existent aux adresses du devnet
// (tests/fixtures) avec le wallet des tests comme autorité d'émission.
describe("séquestre en jetons USDC / EURC (2 sur 3)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const EURC = new anchor.web3.PublicKey("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr");
  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const RELEASE = 1;
  const REFUND = 2;
  const AMOUNT = 1_000_000; // 1 jeton (6 décimales)
  const FEE_15 = 15_000;
  const FEE_6 = 60_000;
  const LOCKED = 925_000;

  const expectRejection = (error: unknown, code: string) => {
    if (error instanceof AssertionError) throw error;
    expect(String(error)).to.contain(code);
  };
  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest });
  };
  const balance = async (address: anchor.web3.PublicKey) => Number((await getAccount(provider.connection, address)).amount);

  async function setup(mint: anchor.web3.PublicKey) {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey);
    await airdrop(seller.publicKey, 1);

    const buyerToken = await createAssociatedTokenAccount(provider.connection, buyer, mint, buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, mint, buyerToken, platformKeypair, AMOUNT);

    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const [distribution] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_distribution"), buyer.publicKey.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("token_vault"), distribution.toBuffer()], program.programId);
    const ata = (owner: anchor.web3.PublicKey, m = mint) => getAssociatedTokenAddressSync(m, owner);
    const programs = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId };

    // Payeur : la plateforme (wallet du provider), seule autorisée à fixer les frais (6 % et 1,5 % ici).
    const initialize = (overrides: Record<string, anchor.web3.PublicKey> = {}) =>
      program.methods
        .initializeTokenDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
        .accountsPartial({
          ...programs, distribution, mint, vault,
          payer: PLATFORM, funder: buyer.publicKey, funderToken: buyerToken,
          recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee15Token: ata(sponsor.publicKey),
          platform: TREASURY, platformToken: ata(TREASURY),
          ...overrides,
        })
        .signers([buyer])
        .rpc();

    // voter = null : l'arbitre (wallet du provider).
    const vote = (voter: anchor.web3.Keypair | null, decision: number) => {
      const call = program.methods.voteTokenDistribution(decision).accountsPartial({
        ...programs, distribution, mint, vault,
        voter: (voter ?? TREASURY_KEYPAIR).publicKey,
        funder: buyer.publicKey, funderToken: buyerToken,
        recipientLocked: seller.publicKey, recipientLockedToken: ata(seller.publicKey),
        payer: PLATFORM,
      });
      return call.signers([voter ?? TREASURY_KEYPAIR]).rpc();
    };
    const fiche = () => program.account.tokenDistribution.fetch(distribution);
    return { buyer, seller, sponsor, buyerToken, distribution, vault, ata, initialize, vote, fiche };
  }

  it("dépôt USDC : frais versés en USDC, 92,5 % dans le coffre en jetons", async () => {
    const t = await setup(USDC);
    const platformBefore = await balance(t.ata(TREASURY)).catch(() => 0);
    await t.initialize();
    expect(await balance(t.buyerToken)).to.equal(0);
    expect(await balance(t.vault)).to.equal(LOCKED);
    expect(await balance(t.ata(t.sponsor.publicKey))).to.equal(FEE_15);
    expect((await balance(t.ata(TREASURY))) - platformBefore).to.equal(FEE_6);
    const f = await t.fiche();
    expect(f.mint.equals(USDC)).to.equal(true);
    expect([f.votes.buyer, f.votes.seller, f.votes.arbiter]).to.deep.equal([0, 0, 0]);
  });

  it("refuse un jeton autre qu'USDC ou EURC", async () => {
    const t = await setup(USDC);
    const otherMint = await createMint(provider.connection, platformKeypair, PLATFORM, null, 6);
    const otherBuyerToken = await createAssociatedTokenAccount(provider.connection, t.buyer, otherMint, t.buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, otherMint, otherBuyerToken, platformKeypair, AMOUNT);
    try {
      await t.initialize({
        mint: otherMint, funderToken: otherBuyerToken,
        recipientFee15Token: t.ata(t.sponsor.publicKey, otherMint), platformToken: t.ata(TREASURY, otherMint),
      });
      expect.fail("un jeton non accepté doit être refusé");
    } catch (error) {
      expectRejection(error, "UnsupportedMint");
    }
  });

  it("transaction réussie en USDC : acheteur puis vendeur, jetons au vendeur, coffre fermé", async () => {
    const t = await setup(USDC);
    await t.initialize();
    await t.vote(t.buyer, RELEASE);
    expect(await balance(t.vault)).to.equal(LOCKED);
    // Compte de jetons du bénéficiaire créé d'avance (par la plateforme dans l'application) : le vote ne le crée pas.
    await createAssociatedTokenAccount(provider.connection, platformKeypair, USDC, t.seller.publicKey);
    await t.vote(t.seller, RELEASE);
    expect(await balance(t.ata(t.seller.publicKey))).to.equal(LOCKED);
    expect(await provider.connection.getAccountInfo(t.vault)).to.equal(null);
    expect((await t.fiche()).released).to.equal(true);
    // Le coffre en jetons est fermé : tout vote ultérieur échoue faute de coffre.
    try { await t.vote(t.buyer, RELEASE); expect.fail("vote après libération accepté"); } catch (e) { expectRejection(e, "AccountNotInitialized"); }
  });

  it("litige EURC tranché pour l'acheteur : arbitre puis acheteur, jetons remboursés", async () => {
    const t = await setup(EURC);
    await t.initialize();
    await t.vote(null, REFUND);
    try { await t.vote(null, RELEASE); expect.fail("changement de vote de l'arbitre accepté"); } catch (e) { expectRejection(e, "VoteAlreadyCast"); }
    await t.vote(t.buyer, REFUND);
    expect(await balance(t.buyerToken)).to.equal(LOCKED);
    expect(await provider.connection.getAccountInfo(t.vault)).to.equal(null);
    expect((await t.fiche()).cancelled).to.equal(true);
  });

  // Le vendeur change le propriétaire de son compte USDC (SetAuthority AccountOwner, permis par le SPL Token classique)
  // pour rendre son compte « non conforme » : le remboursement à l'acheteur ne lit pas ce compte et passe quand même.
  it("vendeur malhonnête : propriétaire de son compte USDC changé, le remboursement à l'acheteur passe quand même", async () => {
    const t = await setup(USDC);
    await t.initialize();
    const sellerToken = await createAssociatedTokenAccount(provider.connection, t.seller, USDC, t.seller.publicKey);
    await setAuthority(provider.connection, t.seller, sellerToken, t.seller, AuthorityType.AccountOwner, anchor.web3.Keypair.generate().publicKey);
    await t.vote(null, REFUND);
    await t.vote(t.buyer, REFUND);
    expect(await balance(t.buyerToken)).to.equal(LOCKED);
    expect((await t.fiche()).cancelled).to.equal(true);
  });

  it("versement refusé vers un compte de jetons qui n'appartient plus au bénéficiaire ; accepté vers un autre compte à lui", async () => {
    const t = await setup(USDC);
    await t.initialize();
    const sellerToken = await createAssociatedTokenAccount(provider.connection, t.seller, USDC, t.seller.publicKey);
    await setAuthority(provider.connection, t.seller, sellerToken, t.seller, AuthorityType.AccountOwner, anchor.web3.Keypair.generate().publicKey);
    await t.vote(t.buyer, RELEASE);
    try { await t.vote(t.seller, RELEASE); expect.fail("versement vers un compte d'autrui accepté"); } catch (e) { expectRejection(e, "InvalidTokenDestination"); }
    // Autre compte de jetons du vendeur (hors compte associé) : le vendeur reste payable.
    const other = await createAccount(provider.connection, t.seller, USDC, t.seller.publicKey, anchor.web3.Keypair.generate());
    await program.methods.voteTokenDistribution(RELEASE).accountsPartial({
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
      distribution: t.distribution, mint: USDC, vault: t.vault, voter: t.seller.publicKey,
      funder: t.buyer.publicKey, funderToken: t.buyerToken, recipientLocked: t.seller.publicKey, recipientLockedToken: other, payer: PLATFORM,
    }).signers([t.seller]).rpc();
    expect(await balance(other)).to.equal(LOCKED);
    expect((await t.fiche()).released).to.equal(true);
  });
});
