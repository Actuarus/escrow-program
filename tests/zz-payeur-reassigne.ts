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
import { expect } from "chai";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY } from "./treasury";

// Audit C1 : la clé du payeur (serveur) ne peut pas geler les séquestres en réassignant son propre compte à un autre
// propriétaire. Le payeur n'est plus exigé « compte système » : il est seulement crédité des rentes.
// Dernier fichier de la suite (« zz- ») : la réassignation est définitive sur le validateur local et le payeur ne peut
// plus payer de frais ; les transactions suivantes sont payées par les parties.
describe("payeur réassigné à un autre propriétaire : les règlements restent possibles (audit C1)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const RELEASE = 1;
  const AMOUNT = 1_000_000_000;
  const LOCKED = AMOUNT - AMOUNT * 750 / 10_000;
  const system = { systemProgram: anchor.web3.SystemProgram.programId };
  const programs = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...system };

  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest });
  };
  const pda = (...parts: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(parts, program.programId)[0];
  const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(USDC, owner);
  // Transaction payée par `feePayer` (le payeur réassigné ne peut plus payer de frais).
  const send = async (transaction: anchor.web3.Transaction, feePayer: anchor.web3.Keypair, ...signers: anchor.web3.Keypair[]) => {
    const latest = await provider.connection.getLatestBlockhash();
    transaction.feePayer = feePayer.publicKey;
    transaction.recentBlockhash = latest.blockhash;
    transaction.sign(feePayer, ...signers.filter(s => !s.publicKey.equals(feePayer.publicKey)));
    const signature = await provider.connection.sendRawTransaction(transaction.serialize());
    await provider.connection.confirmTransaction({ signature, ...latest });
    return signature;
  };

  it("dépôt en jetons : après la réassignation du payeur, les votes concordants versent les jetons au vendeur", async () => {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    await Promise.all([airdrop(buyer.publicKey), airdrop(seller.publicKey, 1)]);
    const buyerToken = await createAssociatedTokenAccount(provider.connection, buyer, USDC, buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, USDC, buyerToken, platformKeypair, AMOUNT);
    await createAssociatedTokenAccount(provider.connection, seller, USDC, seller.publicKey);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const distribution = pda(Buffer.from("token_distribution"), buyer.publicKey.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8));
    const vault = pda(Buffer.from("token_vault"), distribution.toBuffer());
    await program.methods.initializeTokenDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        ...programs, distribution, mint: USDC, vault, payer: PLATFORM, funder: buyer.publicKey, funderToken: buyerToken,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee15Token: ata(sponsor.publicKey),
        platform: TREASURY, platformToken: ata(TREASURY),
      })
      .signers([buyer]).rpc();

    // Le payeur (clé du serveur) se réassigne à un propriétaire quelconque : il n'appartient plus au System Program.
    await send(new anchor.web3.Transaction().add(anchor.web3.SystemProgram.assign({ accountPubkey: PLATFORM, programId: anchor.web3.Keypair.generate().publicKey })), buyer, platformKeypair);
    expect((await provider.connection.getAccountInfo(PLATFORM))!.owner.equals(anchor.web3.SystemProgram.programId)).to.equal(false);

    const vote = async (voter: anchor.web3.Keypair) => send(await program.methods.voteTokenDistribution(RELEASE).accountsPartial({
      ...programs, distribution, mint: USDC, vault, voter: voter.publicKey, funder: buyer.publicKey, funderToken: buyerToken,
      recipientLocked: seller.publicKey, recipientLockedToken: ata(seller.publicKey), payer: PLATFORM,
    }).transaction(), voter);
    await vote(buyer);
    await vote(seller);
    expect(Number((await getAccount(provider.connection, ata(seller.publicKey))).amount)).to.equal(LOCKED);
    expect(await provider.connection.getAccountInfo(vault)).to.equal(null);
    expect((await program.account.tokenDistribution.fetch(distribution)).released).to.equal(true);
  });
});
