import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY, TREASURY_KEYPAIR } from "./treasury";
import { expect, AssertionError } from "chai";

// Séquestre en SOL, multisignature 2 sur 3 : acheteur, vendeur et arbitre (compte plateforme, wallet des tests).
describe("séquestre SOL (2 sur 3)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const RELEASE = 1;
  const REFUND = 2;
  const AMOUNT = 1_000_000; // lamports
  const FEE_15 = 15_000;
  const FEE_6 = 60_000;
  const LOCKED = 925_000;
  const LOCKED_BPS_SEED = new anchor.BN(9_250).toArrayLike(Buffer, "le", 8);
  const FEE_15_BPS_SEED = new anchor.BN(150).toArrayLike(Buffer, "le", 8);
  const FEE_6_BPS_SEED = new anchor.BN(600).toArrayLike(Buffer, "le", 8);

  before(() => {
    if (!provider.wallet.publicKey.equals(PLATFORM)) {
      throw new Error(`Le wallet du provider (${provider.wallet.publicKey.toBase58()}) doit être le compte plateforme ${PLATFORM.toBase58()}.`);
    }
  });

  const expectRejection = (error: unknown, code?: string) => {
    if (error instanceof AssertionError) throw error;
    if (code) expect(String(error)).to.contain(code);
  };
  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest });
  };
  const lamports = (pubkey: anchor.web3.PublicKey) => provider.connection.getBalance(pubkey);

  async function setup() {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    const stranger = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey);
    await airdrop(seller.publicKey, 1);
    await airdrop(sponsor.publicKey, 1);
    await airdrop(stranger.publicKey, 1);

    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const idBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [distribution] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("distribution"), buyer.publicKey.toBuffer(), idBytes], program.programId);
    const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), buyer.publicKey.toBuffer(), idBytes, LOCKED_BPS_SEED, FEE_15_BPS_SEED, FEE_6_BPS_SEED], program.programId);

    // Payeur par défaut : la plateforme (wallet du provider), seule autorisée à fixer les frais (6 % et 1,5 %).
    const initialize = (overrides: Record<string, anchor.web3.PublicKey> = {}, amount = AMOUNT) =>
      program.methods
        .initializeDistributionExact(paymentId, new anchor.BN(amount), new anchor.BN(Math.floor(amount * 600 / 10_000)), new anchor.BN(Math.floor(amount * 150 / 10_000)))
        .accountsPartial({
          distribution, vault,
          payer: PLATFORM, funder: buyer.publicKey,
          recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee6: TREASURY,
          systemProgram: anchor.web3.SystemProgram.programId,
          ...overrides,
        })
        .signers([buyer])
        .rpc();

    // voter = null : l'arbitre (wallet du provider, signataire par défaut).
    const vote = (voter: anchor.web3.Keypair | null, decision: number) => {
      const call = program.methods.voteDistribution(decision).accountsPartial({
        distribution, vault,
        voter: (voter ?? TREASURY_KEYPAIR).publicKey,
        funder: buyer.publicKey, recipientLocked: seller.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      });
      return call.signers([voter ?? TREASURY_KEYPAIR]).rpc();
    };
    const fiche = () => program.account.paymentDistribution.fetch(distribution);
    return { buyer, seller, sponsor, stranger, distribution, vault, initialize, vote, fiche };
  }

  it("dépôt : 1,5 % au parrain, 6 % à la plateforme, 92,5 % dans le coffre, aucun vote", async () => {
    const t = await setup();
    const sponsorBefore = await lamports(t.sponsor.publicKey);
    await t.initialize();
    expect((await lamports(t.sponsor.publicKey)) - sponsorBefore).to.equal(FEE_15);
    const vaultRent = await provider.connection.getMinimumBalanceForRentExemption(0);
    expect(await lamports(t.vault)).to.equal(vaultRent + LOCKED);
    const f = await t.fiche();
    expect(f.lockedAmount.toNumber()).to.equal(LOCKED);
    expect(f.feeAmount6.toNumber()).to.equal(FEE_6);
    expect([f.votes.buyer, f.votes.seller, f.votes.arbiter]).to.deep.equal([0, 0, 0]);
    expect(f.released || f.cancelled).to.equal(false);
  });

  it("refuse : montant trop faible, destinataire 6 % autre que la plateforme, participants non distincts", async () => {
    const t = await setup();
    try { await t.initialize({}, 0); expect.fail("montant nul accepté"); } catch (e) { expectRejection(e, "InvalidAmount"); }
    try { await t.initialize({ recipientFee6: t.sponsor.publicKey }); expect.fail("destinataire 6 % arbitraire accepté"); } catch (e) { expectRejection(e, "InvalidFeeRecipient"); }
    try { await t.initialize({ recipientLocked: t.buyer.publicKey }); expect.fail("acheteur = vendeur accepté"); } catch (e) { expectRejection(e, "InvalidParticipants"); }
    try { await t.initialize({ recipientLocked: PLATFORM }); expect.fail("plateforme comme vendeur acceptée"); } catch (e) { expectRejection(e, "InvalidParticipants"); }
    // Payeur et trésorerie séparés : les frais vont à la trésorerie seule ; ni l'un ni l'autre ne peut être une partie.
    try { await t.initialize({ recipientFee6: PLATFORM }); expect.fail("frais versés au payeur acceptés"); } catch (e) { expectRejection(e, "InvalidFeeRecipient"); }
    try { await t.initialize({ recipientLocked: TREASURY }); expect.fail("trésorerie comme vendeur acceptée"); } catch (e) { expectRejection(e, "InvalidParticipants"); }
  });

  it("transaction réussie : l'acheteur puis le vendeur votent « libérer », les fonds partent au vendeur", async () => {
    const t = await setup();
    await t.initialize();
    const sellerBefore = await lamports(t.seller.publicKey);

    await t.vote(t.buyer, RELEASE);
    expect((await t.fiche()).released).to.equal(false);
    expect(await lamports(t.seller.publicKey)).to.equal(sellerBefore);

    await t.vote(t.seller, RELEASE);
    // Le vendeur reçoit la part séquestrée (moins les frais de sa transaction), pas la rente du coffre (audit SC-02).
    expect((await lamports(t.seller.publicKey)) - sellerBefore).to.be.within(LOCKED - 10_000, LOCKED);
    expect(await lamports(t.vault)).to.equal(0);
    const f = await t.fiche();
    expect(f.released).to.equal(true);
    expect([f.votes.buyer, f.votes.seller, f.votes.arbiter]).to.deep.equal([RELEASE, RELEASE, 0]);

    try { await t.vote(null, REFUND); expect.fail("vote après libération accepté"); } catch (e) { expectRejection(e, "AlreadyReleased"); }
  });

  it("un vote est définitif ; un tiers ne peut pas voter ; vote invalide refusé", async () => {
    const t = await setup();
    await t.initialize();
    await t.vote(t.buyer, RELEASE);
    try { await t.vote(t.buyer, REFUND); expect.fail("changement de vote accepté"); } catch (e) { expectRejection(e, "VoteAlreadyCast"); }
    try { await t.vote(t.stranger, RELEASE); expect.fail("vote d'un tiers accepté"); } catch (e) { expectRejection(e, "Unauthorized"); }
    // Le payeur de la plateforme (clé du serveur) n'est pas l'arbitre : seule la trésorerie (multisig) vote.
    const payerVote = program.methods.voteDistribution(RELEASE).accountsPartial({ distribution: t.distribution, vault: t.vault, voter: PLATFORM, funder: t.buyer.publicKey, recipientLocked: t.seller.publicKey, systemProgram: anchor.web3.SystemProgram.programId });
    try { await payerVote.rpc(); expect.fail("vote d'arbitre du payeur accepté"); } catch (e) { expectRejection(e, "Unauthorized"); }
    try { await t.vote(t.seller, 3); expect.fail("vote invalide accepté"); } catch (e) { expectRejection(e, "InvalidVote"); }
  });

  it("litige tranché pour l'acheteur : l'arbitre puis l'acheteur votent « rembourser »", async () => {
    const t = await setup();
    await t.initialize();
    const buyerBefore = await lamports(t.buyer.publicKey);
    await t.vote(null, REFUND);
    await t.vote(t.buyer, REFUND);
    expect((await lamports(t.buyer.publicKey)) - buyerBefore).to.be.at.least(LOCKED - 10_000);
    expect((await t.fiche()).cancelled).to.equal(true);
  });

  it("votes partagés : l'arbitre départage ; litige tranché pour le vendeur", async () => {
    const t = await setup();
    await t.initialize();
    const sellerBefore = await lamports(t.seller.publicKey);
    await t.vote(t.buyer, REFUND);
    await t.vote(t.seller, RELEASE);
    expect((await t.fiche()).released || (await t.fiche()).cancelled).to.equal(false);
    await t.vote(null, RELEASE);
    expect((await lamports(t.seller.publicKey)) - sellerBefore).to.be.at.least(LOCKED);
    expect((await t.fiche()).released).to.equal(true);
  });

  // Une partie transfère son wallet à un autre programme (SystemProgram.assign, une signature) pour rendre son compte
  // « non conforme » : l'issue qui la défavorise doit rester possible (sinon fonds gelés et chantage).
  const assignAway = async (party: anchor.web3.Keypair) => {
    const ix = anchor.web3.SystemProgram.assign({ accountPubkey: party.publicKey, programId: anchor.web3.Keypair.generate().publicKey });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [party]);
  };

  it("vendeur malhonnête : wallet transféré à un autre programme, le remboursement à l'acheteur passe quand même", async () => {
    const t = await setup();
    await t.initialize();
    await assignAway(t.seller);
    const buyerBefore = await lamports(t.buyer.publicKey);
    await t.vote(null, REFUND);
    await t.vote(t.buyer, REFUND);
    expect((await lamports(t.buyer.publicKey)) - buyerBefore).to.be.at.least(LOCKED - 10_000);
    expect((await t.fiche()).cancelled).to.equal(true);
  });

  it("acheteur malhonnête : wallet transféré à un autre programme, le versement au vendeur passe quand même", async () => {
    const t = await setup();
    await t.initialize();
    await t.vote(t.buyer, REFUND);
    await assignAway(t.buyer);
    const sellerBefore = await lamports(t.seller.publicKey);
    await t.vote(t.seller, RELEASE);
    await t.vote(null, RELEASE);
    expect((await lamports(t.seller.publicKey)) - sellerBefore).to.be.at.least(LOCKED);
    expect((await t.fiche()).released).to.equal(true);
  });
});
