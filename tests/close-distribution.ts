import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { expect, AssertionError } from "chai";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY } from "./treasury";

// Clôture d'un dépôt soldé : fiche, termes, garantie et proposition éventuelle fermés par la plateforme seule, leur
// rente rendue au payeur du dépôt. Refusée tant que les fonds ne sont pas partis.
describe("clôture des comptes d'un dépôt soldé", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const RELEASE = 1;
  const AMOUNT = 1_000_000_000;
  const SHORT = 2;
  const SEEDS = [9_250, 150, 600].map(v => new anchor.BN(v).toArrayLike(Buffer, "le", 8));
  const system = { systemProgram: anchor.web3.SystemProgram.programId };

  const expectRejection = (error: unknown, code: string) => {
    if (error instanceof AssertionError) throw error;
    expect(String(error)).to.contain(code);
  };
  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest });
  };
  const lamports = (pubkey: anchor.web3.PublicKey) => provider.connection.getBalance(pubkey);
  const pda = (...parts: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(parts, program.programId)[0];
  const related = (distribution: anchor.web3.PublicKey) => ({
    terms: pda(Buffer.from("terms"), distribution.toBuffer()),
    lock: pda(Buffer.from("guarantee"), distribution.toBuffer()),
    partialRefund: pda(Buffer.from("partial_refund"), distribution.toBuffer()),
  });
  const close = (distribution: anchor.web3.PublicKey, { payer = PLATFORM, platform = platformKeypair }: { payer?: anchor.web3.PublicKey; platform?: anchor.web3.Keypair } = {}) =>
    program.methods.closeDistribution()
      .accountsPartial({ distribution, ...related(distribution), payer, platform: platform.publicKey })
      .signers([platform]).rpc();
  // Rente rendue au payeur, frais de la clôture (une signature) déduits. Le solde du payeur sur le validateur local
  // dépasse la précision des nombres JavaScript (2^53) : écart d'arrondi de quelques lamports toléré.
  const FEE = 5_000;
  const expectRentReturned = (gain: number, rent: number) => expect(gain).to.be.closeTo(rent - FEE, 16);
  // Rente totale des comptes existants parmi ceux donnés.
  const rentOf = async (addresses: anchor.web3.PublicKey[]) =>
    (await Promise.all(addresses.map(lamports))).reduce((sum, value) => sum + value, 0);

  before(async () => { await airdrop(PLATFORM, 10); });

  it("SOL : refusée tant que le dépôt est ouvert, par un tiers ou vers un autre payeur ; puis fiche, termes, garantie et proposition fermés", async () => {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    const stranger = anchor.web3.Keypair.generate();
    await Promise.all([airdrop(buyer.publicKey, 3), airdrop(seller.publicKey, 1), airdrop(sponsor.publicKey, 1), airdrop(stranger.publicKey, 1)]);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const idBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const distribution = pda(Buffer.from("distribution"), buyer.publicKey.toBuffer(), idBytes);
    const vault = pda(Buffer.from("vault"), buyer.publicKey.toBuffer(), idBytes, ...SEEDS);
    const { terms, lock, partialRefund } = related(distribution);
    await program.methods.initializeDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        distribution, vault, payer: PLATFORM, funder: buyer.publicKey,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee6: TREASURY, ...system,
      })
      .signers([buyer]).rpc();
    await program.methods.recordTerms(new anchor.BN(SHORT)).accountsPartial({ terms, distribution, funder: buyer.publicKey, platform: PLATFORM, ...system })
      .signers([buyer]).rpc();
    await program.methods.startGuarantee(new anchor.BN(SHORT)).accountsPartial({ lock, distribution, terms, platform: PLATFORM, ...system }).rpc();
    await program.methods.proposePartialRefund(new anchor.BN(100_000_000))
      .accountsPartial({ proposal: partialRefund, distribution, seller: seller.publicKey, platform: PLATFORM, ...system })
      .signers([seller]).rpc();

    try { await close(distribution); expect.fail("dépôt ouvert fermé"); } catch (e) { expectRejection(e, "DistributionStillOpen"); }

    // Votes concordants « libérer » : fonds au vendeur, la proposition reste en place.
    const vote = (voter: anchor.web3.Keypair) => program.methods.voteDistribution(RELEASE).accountsPartial({
      distribution, vault, voter: voter.publicKey, funder: buyer.publicKey, recipientLocked: seller.publicKey, ...system,
    }).signers([voter]).rpc();
    await vote(buyer);
    await vote(seller);

    try { await close(distribution, { platform: stranger }); expect.fail("clôture par un tiers"); } catch (e) { expectRejection(e, "Unauthorized"); }
    try { await close(distribution, { payer: stranger.publicKey }); expect.fail("rente versée à un autre que le payeur"); } catch (e) { expectRejection(e, "Unauthorized"); }

    const accounts = [distribution, terms, lock, partialRefund];
    const rent = await rentOf(accounts);
    expect(rent).to.be.greaterThan(0);
    const platformBefore = await lamports(PLATFORM);
    await close(distribution);
    for (const address of accounts) expect(await provider.connection.getAccountInfo(address)).to.equal(null);
    expectRentReturned((await lamports(PLATFORM)) - platformBefore, rent);
    // Une seule clôture : la fiche n'existe plus.
    try { await close(distribution); expect.fail("deuxième clôture"); } catch (e) { expectRejection(e, "InvalidDistribution"); }
  });

  it("jetons : dépôt sans termes ni garantie, soldé par un remboursement partiel accepté → fiche fermée", async () => {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    await Promise.all([airdrop(buyer.publicKey), airdrop(seller.publicKey, 1)]);
    const buyerToken = await createAssociatedTokenAccount(provider.connection, buyer, USDC, buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, USDC, buyerToken, platformKeypair, AMOUNT);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const distribution = pda(Buffer.from("token_distribution"), buyer.publicKey.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8));
    const vault = pda(Buffer.from("token_vault"), distribution.toBuffer());
    const { partialRefund } = related(distribution);
    const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(USDC, owner);
    const programs = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...system };
    await program.methods.initializeTokenDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        ...programs, distribution, mint: USDC, vault, payer: PLATFORM, funder: buyer.publicKey, funderToken: buyerToken,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee15Token: ata(sponsor.publicKey),
        platform: TREASURY, platformToken: ata(TREASURY),
      })
      .signers([buyer]).rpc();
    await program.methods.proposePartialRefund(new anchor.BN(400_000_000))
      .accountsPartial({ proposal: partialRefund, distribution, seller: seller.publicKey, platform: PLATFORM, ...system })
      .signers([seller]).rpc();
    await program.methods.acceptTokenPartialRefund(new anchor.BN(400_000_000)).accountsPartial({
      ...programs, distribution, mint: USDC, vault, proposal: partialRefund, funder: buyer.publicKey, funderToken: ata(buyer.publicKey),
      recipientLocked: seller.publicKey, recipientLockedToken: ata(seller.publicKey), payer: PLATFORM,
    }).signers([buyer]).rpc();

    const rent = await lamports(distribution);
    const platformBefore = await lamports(PLATFORM);
    await close(distribution);
    expect(await provider.connection.getAccountInfo(distribution)).to.equal(null);
    expectRentReturned((await lamports(PLATFORM)) - platformBefore, rent);
  });
});
