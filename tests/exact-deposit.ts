import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { expect, AssertionError } from "chai";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY, TREASURY_KEYPAIR } from "./treasury";

// Dépôt aux montants exacts : la plateforme fixe la part plateforme et la part parrain (commission par paliers et
// part du parrain calculées par l'application) ; le reste est séquestré pour le vendeur. Frais ≤ 50 % du dépôt.
describe("dépôt aux montants exacts (commission par paliers, part du parrain)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const SEEDS = [9_250, 150, 600].map(v => new anchor.BN(v).toArrayLike(Buffer, "le", 8));
  const system = { systemProgram: anchor.web3.SystemProgram.programId };
  const RELEASE = 1;

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

  async function parties() {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey, 3);
    await airdrop(seller.publicKey, 1);
    await airdrop(sponsor.publicKey, 1);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    return { buyer, seller, sponsor, paymentId, idBytes: paymentId.toArrayLike(Buffer, "le", 8) };
  }
  const solDeposit = (p: Awaited<ReturnType<typeof parties>>, amount: number, platformFee: number, sponsorFee: number, payer: anchor.web3.Keypair | null = null) => {
    const distribution = pda(Buffer.from("distribution"), p.buyer.publicKey.toBuffer(), p.idBytes);
    const vault = pda(Buffer.from("vault"), p.buyer.publicKey.toBuffer(), p.idBytes, ...SEEDS);
    const call = program.methods.initializeDistributionExact(p.paymentId, new anchor.BN(amount), new anchor.BN(platformFee), new anchor.BN(sponsorFee))
      .accountsPartial({
        distribution, vault, payer: payer ? payer.publicKey : PLATFORM, funder: p.buyer.publicKey,
        recipientLocked: p.seller.publicKey, recipientFee15: p.sponsor.publicKey, recipientFee6: TREASURY, ...system,
      });
    return { distribution, vault, send: () => call.signers(payer ? [p.buyer, payer] : [p.buyer]).rpc() };
  };

  before(async () => { await airdrop(PLATFORM, 10); });

  it("SOL : parts plateforme et parrain au lamport près, reste séquestré ; votes inchangés", async () => {
    const p = await parties();
    // Deal de 20 000 € : commission par paliers 1 250 € (750 + 500), parrain 22 % = 275 €, plateforme 975 € ; à l'échelle
    // 1 € = 100 000 lamports : dépôt 2 125 000 000 (21 250 €).
    const AMOUNT = 2_125_000_000, PLATFORM_FEE = 97_500_000, SPONSOR_FEE = 27_500_000;
    const d = solDeposit(p, AMOUNT, PLATFORM_FEE, SPONSOR_FEE);
    const [sponsorBefore, platformBefore] = await Promise.all([lamports(p.sponsor.publicKey), lamports(TREASURY)]);
    await d.send();
    expect((await lamports(p.sponsor.publicKey)) - sponsorBefore).to.equal(SPONSOR_FEE);
    expect((await lamports(TREASURY)) - platformBefore).to.be.within(PLATFORM_FEE - 20_000_000, PLATFORM_FEE);
    const fiche = await program.account.paymentDistribution.fetch(d.distribution);
    expect([fiche.totalAmount.toNumber(), fiche.lockedAmount.toNumber(), fiche.feeAmount15.toNumber(), fiche.feeAmount6.toNumber()])
      .to.deep.equal([AMOUNT, AMOUNT - PLATFORM_FEE - SPONSOR_FEE, SPONSOR_FEE, PLATFORM_FEE]);
    // Votes : acheteur puis vendeur « libérer ».
    const vote = (voter: anchor.web3.Keypair) => program.methods.voteDistribution(RELEASE).accountsPartial({
      distribution: d.distribution, vault: d.vault, voter: voter.publicKey, funder: p.buyer.publicKey, recipientLocked: p.seller.publicKey, ...system,
    }).signers([voter]).rpc();
    const sellerBefore = await lamports(p.seller.publicKey);
    await vote(p.buyer);
    await vote(p.seller);
    expect((await lamports(p.seller.publicKey)) - sellerBefore).to.be.at.least(AMOUNT - PLATFORM_FEE - SPONSOR_FEE - 10_000);
  });

  it("refuse : sans la signature de la plateforme, frais au-delà de 50 %, part séquestrée nulle", async () => {
    const p = await parties();
    const stranger = anchor.web3.Keypair.generate();
    await airdrop(stranger.publicKey, 1);
    try { await solDeposit(p, 100_000_000, 5_000_000, 1_000_000, stranger).send(); expect.fail("dépôt sans la plateforme"); } catch (e) { expectRejection(e, "UnauthorizedFeeRates"); }
    try { await solDeposit(p, 100_000_000, 40_000_000, 10_000_001).send(); expect.fail("frais > 50 %"); } catch (e) { expectRejection(e, "InvalidFeeRates"); }
    // 50 % exactement : accepté.
    await solDeposit(p, 100_000_000, 40_000_000, 10_000_000).send();
  });

  it("jetons : parts exactes en USDC, reste séquestré dans le coffre", async () => {
    const p = await parties();
    const buyerToken = await createAssociatedTokenAccount(provider.connection, p.buyer, USDC, p.buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, USDC, buyerToken, platformKeypair, 2_000_000_000);
    const distribution = pda(Buffer.from("token_distribution"), p.buyer.publicKey.toBuffer(), p.idBytes);
    const vault = pda(Buffer.from("token_vault"), distribution.toBuffer());
    const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(USDC, owner);
    // Deal de 1 000 USDC : commission 75 USDC (7,5 %), parrain 22 % = 16,5, plateforme 58,5 ; dépôt 1 075 USDC.
    await program.methods.initializeTokenDistributionExact(p.paymentId, new anchor.BN(1_075_000_000), new anchor.BN(58_500_000), new anchor.BN(16_500_000))
      .accountsPartial({
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...system,
        distribution, mint: USDC, vault, payer: PLATFORM, funder: p.buyer.publicKey, funderToken: buyerToken,
        recipientLocked: p.seller.publicKey, recipientFee15: p.sponsor.publicKey, recipientFee15Token: ata(p.sponsor.publicKey),
        platform: TREASURY, platformToken: ata(TREASURY),
      })
      .signers([p.buyer]).rpc();
    expect(Number((await getAccount(provider.connection, ata(p.sponsor.publicKey))).amount)).to.equal(16_500_000);
    expect(Number((await getAccount(provider.connection, vault)).amount)).to.equal(1_000_000_000);
    const fiche = await program.account.tokenDistribution.fetch(distribution);
    expect([fiche.lockedAmount.toNumber(), fiche.feeAmount15.toNumber(), fiche.feeAmount6.toNumber()]).to.deep.equal([1_000_000_000, 16_500_000, 58_500_000]);
  });
});
