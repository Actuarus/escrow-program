use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("DNwHyasEkHQYfswjPAxvnudCgN1gdZuHA2y2TSp8GVXE");

// Séquestre ACTUARUS en multisignature 2 sur 3.
// Trois signataires par dépôt : l'acheteur (déposant), le vendeur (bénéficiaire) et l'arbitre (compte plateforme).
// Chacun vote une seule fois « libérer » ou « rembourser » ; au deuxième vote identique, les fonds partent :
// au vendeur pour « libérer », à l'acheteur pour « rembourser ». Personne ne peut déplacer les fonds seul.
// Les frais (parrain, plateforme) sont versés au dépôt, aux montants fixés par la plateforme pour chaque dépôt
// (paramètres de la plateforme) : ils ne sont acceptés que si le dépôt est payé et signé par le compte plateforme.
// Garantie (timelock) : quand le vendeur a déposé les documents, la plateforme ouvre la période de garantie
// (start_guarantee). À son terme, si aucun vote « rembourser » n'existe et qu'aucun litige ne l'a suspendue
// (suspend_guarantee), n'importe qui peut déclencher le versement au vendeur (release_after_guarantee) : les fonds
// ne restent pas bloqués faute de second vote. Elle dure au moins 24 heures (MIN_GUARANTEE_SECONDS).
// Une issue ne contrôle que le compte de son bénéficiaire : une partie ne peut pas bloquer l'issue qui la défavorise en
// rendant son propre compte non conforme.
// Remboursement partiel : le vendeur propose (et peut modifier tant que l'acheteur n'a pas accepté) de rendre une
// partie du montant séquestré (propose_partial_refund) ; l'acheteur accepte ce montant exact (accept_partial_refund,
// accept_token_partial_refund) : la part proposée lui revient, le reste au vendeur, dans la même transaction. Deux
// signatures sur trois (vendeur et acheteur) ; l'arbitre ne peut pas imposer de partage. Une proposition en attente
// bloque le versement automatique de fin de garantie ; l'acheteur peut la refuser (decline_partial_refund).
// Clôture : une fois le dépôt soldé, la plateforme ferme sa fiche, ses termes, sa garantie et sa proposition éventuelle
// (close_distribution) ; leur rente revient au payeur du dépôt. L'historique reste dans les transactions.
// Rentes : le payeur du dépôt (la plateforme) paie la rente de chaque compte et la récupère au règlement ou à la
// clôture ; les parties reçoivent exactement les montants du dépôt (audit SC-02).

const BPS_DENOMINATOR: u64 = 10_000;
/// Total des frais (plateforme + parrain) au plus : 50 %.
const MAX_FEE_BPS: u64 = 5_000;
// Graines historiques du coffre SOL (taux d'origine 92,5 % / 1,5 % / 6 %) : conservées telles quelles pour que
// les coffres des dépôts existants gardent leur adresse. Elles ne fixent plus les taux.
const LOCKED_BPS_SEED: [u8; 8] = 9_250u64.to_le_bytes();
const FEE_15_BPS_SEED: [u8; 8] = 150u64.to_le_bytes();
const FEE_6_BPS_SEED: [u8; 8] = 600u64.to_le_bytes();

// Binaire de test (trésorerie dont la clé est versionnée, garanties d'une seconde) jamais compilé pour le mainnet
// (audit P-M14).
#[cfg(all(feature = "mainnet", feature = "test-treasury"))]
compile_error!("Les features « mainnet » et « test-treasury » sont incompatibles : la trésorerie de test n'a pas sa place sur le mainnet.");

/// Payeur de la plateforme (clé du serveur) : paie les frais réseau et les loyers, autorise les montants des dépôts,
/// ouvre et suspend les garanties, accompagne les remboursements partiels. Ni arbitre, ni destinataire des frais.
#[cfg(not(feature = "mainnet"))]
pub const PLATFORM_PAYER: Pubkey = pubkey!("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
// Payeur de production : wallet distinct de celui de la recette (clé privée en secret du serveur de production).
#[cfg(feature = "mainnet")]
pub const PLATFORM_PAYER: Pubkey = pubkey!("7yZkzP5h4aGefT6iHpu6HKFaUSPDv2hBPgfuWcx922A5");

/// Trésorerie de la plateforme : vault Squads (multisig 2 sur 3). Destinataire des frais de plateforme et arbitre
/// (troisième signataire) ; ses votes passent par une proposition approuvée par deux signataires du multisig.
#[cfg(feature = "mainnet")]
pub const PLATFORM_TREASURY: Pubkey = pubkey!("BozjdKhvXyZVUBWrmHgF74QuACS4eswi2kmxLNRLY3y5");
#[cfg(all(not(feature = "mainnet"), not(feature = "test-treasury")))]
pub const PLATFORM_TREASURY: Pubkey = pubkey!("86MWFPvZ1N1r4Ah8oFUMHSeJbMFzat7FXzg6Uu92CtHo");
// Validateur local (tests) : trésorerie de test signant elle-même (tests/fixtures/test-treasury.json).
#[cfg(all(not(feature = "mainnet"), feature = "test-treasury"))]
pub const PLATFORM_TREASURY: Pubkey = pubkey!("DwE2mmppgs8uSDPMUDHerJj78UpgY7zqpEepLDeX7TY4");

/// Durée maximale d'une période de garantie : un an.
const MAX_GUARANTEE_SECONDS: u64 = 365 * 24 * 3_600;
/// Durée minimale d'une période de garantie : 24 heures (audit A3). La clé du serveur, seule à ouvrir une garantie, ne
/// peut donc pas verser les fonds au vendeur sans laisser à l'acheteur une journée entière pour contester.
#[cfg(not(feature = "test-treasury"))]
const MIN_GUARANTEE_SECONDS: u64 = 24 * 3_600;
// Validateur local (tests) : garanties de quelques secondes. Ce binaire n'est jamais déployé (trésorerie de test).
#[cfg(feature = "test-treasury")]
const MIN_GUARANTEE_SECONDS: u64 = 1;

/// Votes possibles.
pub const VOTE_NONE: u8 = 0;
pub const VOTE_RELEASE: u8 = 1;
pub const VOTE_REFUND: u8 = 2;

/// Jetons acceptés en séquestre : USDC et EURC de Circle (SPL Token classique, 6 décimales).
#[cfg(not(feature = "mainnet"))]
pub const ALLOWED_MINTS: [Pubkey; 2] = [
    pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), // USDC devnet
    pubkey!("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"), // EURC devnet
];
#[cfg(feature = "mainnet")]
pub const ALLOWED_MINTS: [Pubkey; 2] = [
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC mainnet
    pubkey!("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"), // EURC mainnet
];

fn is_allowed_mint(mint: &Pubkey) -> bool {
    ALLOWED_MINTS.contains(mint)
}

/// Part d'un montant en points de base (1 bps = 0,01 %), arrondie à l'unité inférieure. Calcul en u128 sans
/// dépassement possible ; le résultat, au plus égal au montant tant que bps ≤ 10 000, est reconverti en u64 avec
/// contrôle.
fn amount_for_bps(amount: u64, bps: u64) -> Result<u64> {
    let share = u128::from(amount)
        .checked_mul(u128::from(bps))
        .and_then(|value| value.checked_div(u128::from(BPS_DENOMINATOR)))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(share).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Acheteur, vendeur et arbitre doivent être trois comptes distincts : sinon un seul compte aurait deux votes. Ni
/// l'un ni l'autre ne peut être le payeur de la plateforme.
fn require_distinct_participants(funder: Pubkey, recipient_locked: Pubkey) -> Result<()> {
    require!(
        funder != recipient_locked
            && funder != PLATFORM_TREASURY
            && recipient_locked != PLATFORM_TREASURY
            && funder != PLATFORM_PAYER
            && recipient_locked != PLATFORM_PAYER,
        EscrowError::InvalidParticipants
    );
    Ok(())
}

/// Votes d'un dépôt et règle de décision, communs au SOL et aux jetons.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Votes {
    pub buyer: u8,
    pub seller: u8,
    pub arbiter: u8,
}

impl Votes {
    /// Enregistre le vote du signataire. Un vote est définitif.
    fn cast(
        &mut self,
        voter: Pubkey,
        funder: Pubkey,
        recipient_locked: Pubkey,
        decision: u8,
    ) -> Result<()> {
        require!(
            decision == VOTE_RELEASE || decision == VOTE_REFUND,
            EscrowError::InvalidVote
        );
        let slot = if voter == funder {
            &mut self.buyer
        } else if voter == recipient_locked {
            &mut self.seller
        } else if voter == PLATFORM_TREASURY {
            &mut self.arbiter
        } else {
            return err!(EscrowError::Unauthorized);
        };
        require!(*slot == VOTE_NONE, EscrowError::VoteAlreadyCast);
        *slot = decision;
        Ok(())
    }

    /// Décision atteinte (deux votes identiques sur trois), ou None.
    fn outcome(self) -> Option<u8> {
        [VOTE_RELEASE, VOTE_REFUND].into_iter().find(|decision| {
            [self.buyer, self.seller, self.arbiter]
                .iter()
                .filter(|vote| **vote == *decision)
                .count()
                >= 2
        })
    }
}

/// Durée de garantie acceptée : une heure au moins (hors binaire de test), un an au plus.
fn valid_guarantee_duration(duration_seconds: u64) -> bool {
    (MIN_GUARANTEE_SECONDS..=MAX_GUARANTEE_SECONDS).contains(&duration_seconds)
}

fn require_open(released: bool, cancelled: bool) -> Result<()> {
    require!(!released, EscrowError::AlreadyReleased);
    require!(!cancelled, EscrowError::AlreadyCancelled);
    Ok(())
}

/// Versement au vendeur à l'issue de la garantie : période échue, non suspendue (litige), sans vote « rembourser ».
fn require_guarantee_release(lock: &GuaranteeLock, votes: Votes, now: i64) -> Result<()> {
    require!(!lock.suspended, EscrowError::GuaranteeSuspended);
    require!(now >= lock.ends_at, EscrowError::GuaranteeNotOver);
    require!(
        votes.buyer != VOTE_REFUND && votes.seller != VOTE_REFUND && votes.arbiter != VOTE_REFUND,
        EscrowError::RefundVotePending
    );
    Ok(())
}

/// Termes d'un dépôt (SOL ou jetons) lus par les instructions communes aux deux : parties, montant séquestré, état.
struct DistributionTerms {
    payer: Pubkey,
    funder: Pubkey,
    recipient_locked: Pubkey,
    locked_amount: u64,
    released: bool,
    cancelled: bool,
}

/// Fiche de dépôt (SOL ou jetons) désignée par son adresse. Erreur si ce n'est pas une fiche de ce programme :
/// propriétaire vérifié ici, en plus de la contrainte `owner` de l'appelant (`VaultLint` VL002), puis discriminant.
fn distribution_terms(info: &AccountInfo) -> Result<DistributionTerms> {
    require_keys_eq!(*info.owner, crate::ID, EscrowError::InvalidDistribution);
    let data = info.try_borrow_data()?;
    if let Ok(d) = PaymentDistribution::try_deserialize(&mut &data[..]) {
        return Ok(DistributionTerms {
            payer: d.payer,
            funder: d.funder,
            recipient_locked: d.recipient_locked,
            locked_amount: d.locked_amount,
            released: d.released,
            cancelled: d.cancelled,
        });
    }
    let d = TokenDistribution::try_deserialize(&mut &data[..])
        .map_err(|_| error!(EscrowError::InvalidDistribution))?;
    Ok(DistributionTerms {
        payer: d.payer,
        funder: d.funder,
        recipient_locked: d.recipient_locked,
        locked_amount: d.locked_amount,
        released: d.released,
        cancelled: d.cancelled,
    })
}

/// Part remboursée : strictement entre zéro et le montant séquestré (le remboursement total reste le vote « rembourser »).
fn require_partial_amount(refund_amount: u64, locked_amount: u64) -> Result<()> {
    require!(
        refund_amount > 0 && refund_amount < locked_amount,
        EscrowError::InvalidRefundAmount
    );
    Ok(())
}

/// Compte de ce programme non vide à l'adresse attendue (proposition, termes, garantie). Un simple virement de SOL à
/// cette adresse (compte système) ne compte pas.
fn program_account_exists(info: &AccountInfo) -> bool {
    *info.owner == crate::ID && !info.data_is_empty()
}

/// Proposition de remboursement partiel en attente : elle bloque le versement automatique de fin de garantie.
fn partial_refund_pending(info: &AccountInfo) -> bool {
    program_account_exists(info)
}

/// Ferme un compte de ce programme : rente versée à `destination`, compte rendu au System Program et vidé (comme la
/// contrainte `close` d'Anchor, sans panique en cas de dépassement).
fn close_program_account<'info>(info: &AccountInfo<'info>, destination: &AccountInfo<'info>) -> Result<()> {
    let lamports = destination
        .lamports()
        .checked_add(info.lamports())
        .ok_or(EscrowError::MathOverflow)?;
    **destination.try_borrow_mut_lamports()? = lamports;
    **info.try_borrow_mut_lamports()? = 0;
    info.assign(&system_program::ID);
    info.resize(0)?;
    Ok(())
}

// ---------- Mouvements de fonds : SOL ----------

fn transfer_from_vault<'info>(
    distribution: &PaymentDistribution,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let payment_id = distribution.payment_id.to_le_bytes();
    let vault_bump = [distribution.vault_bump];
    let signer_seeds = &[&[
        b"vault",
        distribution.funder.as_ref(),
        payment_id.as_ref(),
        LOCKED_BPS_SEED.as_ref(),
        FEE_15_BPS_SEED.as_ref(),
        FEE_6_BPS_SEED.as_ref(),
        vault_bump.as_ref(),
    ][..]];
    let cpi_accounts = Transfer { from, to };
    let cpi_context = CpiContext::new_with_signer(system_program, cpi_accounts, signer_seeds);
    transfer(cpi_context, amount)
}

/// Règlement d'un coffre SOL : `beneficiary_amount` (au plus la part séquestrée) au bénéficiaire, le reste du coffre (sa
/// rente, payée par la plateforme, et tout versement étranger) au payeur du dépôt ; le coffre est vidé (audit SC-02).
fn settle_sol_vault<'info>(
    distribution: &PaymentDistribution,
    vault: AccountInfo<'info>,
    beneficiary: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    beneficiary_amount: u64,
) -> Result<()> {
    let rest = vault
        .lamports()
        .checked_sub(beneficiary_amount)
        .ok_or(EscrowError::InsufficientVaultFunds)?;
    for (to, value) in [(beneficiary, beneficiary_amount), (payer, rest)] {
        if value > 0 {
            transfer_from_vault(distribution, vault.clone(), to, system_program.clone(), value)?;
        }
    }
    Ok(())
}

// ---------- Mouvements de fonds : jetons ----------

/// Compte de jetons qui reçoit un versement : compte SPL Token du jeton du dépôt, appartenant au bénéficiaire (son
/// compte associé ou tout autre compte à lui). Seul le compte du bénéficiaire de l'issue est contrôlé : celui de l'autre
/// partie, qu'elle pourrait rendre non conforme (changement de propriétaire), ne peut pas bloquer cette issue.
fn require_token_destination(info: &AccountInfo, mint: Pubkey, beneficiary: Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, token::ID, EscrowError::InvalidTokenDestination);
    let data = info.try_borrow_data()?;
    let account = TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(EscrowError::InvalidTokenDestination))?;
    require_keys_eq!(account.mint, mint, EscrowError::InvalidTokenDestination);
    require_keys_eq!(
        account.owner,
        beneficiary,
        EscrowError::InvalidTokenDestination
    );
    Ok(())
}

/// Transfère depuis le coffre en jetons, signé par la fiche (PDA propriétaire du coffre).
fn token_transfer_from_vault<'info>(
    distribution: &TokenDistribution,
    distribution_info: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    to: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let payment_id = distribution.payment_id.to_le_bytes();
    let bump = [distribution.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"token_distribution",
        distribution.funder.as_ref(),
        payment_id.as_ref(),
        bump.as_ref(),
    ]];
    let accounts = TransferChecked {
        from: vault,
        mint: mint.to_account_info(),
        to,
        authority: distribution_info,
    };
    token::transfer_checked(
        CpiContext::new_with_signer(token_program, accounts, signer_seeds),
        amount,
        mint.decimals,
    )
}

/// Ferme le coffre vide et rend sa rente au payeur du dépôt.
fn close_token_vault<'info>(
    distribution: &TokenDistribution,
    distribution_info: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let payment_id = distribution.payment_id.to_le_bytes();
    let bump = [distribution.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"token_distribution",
        distribution.funder.as_ref(),
        payment_id.as_ref(),
        bump.as_ref(),
    ]];
    let accounts = CloseAccount {
        account: vault,
        destination,
        authority: distribution_info,
    };
    token::close_account(CpiContext::new_with_signer(
        token_program,
        accounts,
        signer_seeds,
    ))
}

/// Transfère depuis le compte de jetons du déposant (signé par le déposant).
fn token_transfer_from_funder<'info>(
    from: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    to: AccountInfo<'info>,
    funder: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let accounts = TransferChecked {
        from,
        mint: mint.to_account_info(),
        to,
        authority: funder,
    };
    token::transfer_checked(
        CpiContext::new(token_program, accounts),
        amount,
        mint.decimals,
    )
}

/// Dépôt aux montants exacts : seul le compte plateforme fixe les frais (il paie et signe le dépôt).
fn require_platform_payer(payer: Pubkey) -> Result<()> {
    require!(payer == PLATFORM_PAYER, EscrowError::UnauthorizedFeeRates);
    Ok(())
}

/// Répartition d'un dépôt aux montants exacts : (frais du parrain, frais de la plateforme, reste séquestré). Mêmes
/// bornes que les taux : frais au plus égaux à `MAX_FEE_BPS` du dépôt, part séquestrée non nulle.
fn exact_split(amount: u64, platform_fee: u64, sponsor_fee: u64) -> Result<(u64, u64, u64)> {
    require!(amount > 0, EscrowError::InvalidAmount);
    let fees = platform_fee
        .checked_add(sponsor_fee)
        .ok_or(EscrowError::MathOverflow)?;
    let max_fees = amount_for_bps(amount, MAX_FEE_BPS)?;
    require!(fees <= max_fees, EscrowError::InvalidFeeRates);
    let locked_amount = amount.checked_sub(fees).ok_or(EscrowError::MathOverflow)?;
    require!(locked_amount > 0, EscrowError::InvalidDistribution);
    Ok((sponsor_fee, platform_fee, locked_amount))
}

/// Dépôt en SOL : transferts du déposant (coffre, parrain, plateforme) et fiche.
fn open_sol_distribution(
    ctx: Context<InitializeDistribution>,
    payment_id: u64,
    amount: u64,
    (fee_amount_15, fee_amount_6, locked_amount): (u64, u64, u64),
) -> Result<()> {
    require_distinct_participants(
        ctx.accounts.funder.key(),
        ctx.accounts.recipient_locked.key(),
    )?;

    let system_program = ctx.accounts.system_program.to_account_info();
    let funder = ctx.accounts.funder.to_account_info();
    for (to, value) in [
        (ctx.accounts.vault.to_account_info(), locked_amount),
        (
            ctx.accounts.recipient_fee_15.to_account_info(),
            fee_amount_15,
        ),
        (ctx.accounts.recipient_fee_6.to_account_info(), fee_amount_6),
    ] {
        if value > 0 {
            transfer(
                CpiContext::new(
                    system_program.clone(),
                    Transfer {
                        from: funder.clone(),
                        to,
                    },
                ),
                value,
            )?;
        }
    }

    let distribution = &mut ctx.accounts.distribution;
    distribution.payment_id = payment_id;
    distribution.payer = ctx.accounts.payer.key();
    distribution.funder = ctx.accounts.funder.key();
    distribution.recipient_locked = ctx.accounts.recipient_locked.key();
    distribution.recipient_fee_15 = ctx.accounts.recipient_fee_15.key();
    distribution.recipient_fee_6 = PLATFORM_TREASURY;
    distribution.total_amount = amount;
    distribution.locked_amount = locked_amount;
    distribution.fee_amount_15 = fee_amount_15;
    distribution.fee_amount_6 = fee_amount_6;
    distribution.vault = ctx.accounts.vault.key();
    distribution.vault_bump = ctx.bumps.vault;
    distribution.votes = Votes::default();
    distribution.cancelled = false;
    distribution.released = false;
    distribution.bump = ctx.bumps.distribution;

    emit!(DistributionCreated {
        payment_id,
        distribution: distribution.key(),
        mint: None,
        vault: distribution.vault,
        funder: distribution.funder,
        recipient_locked: distribution.recipient_locked,
        recipient_fee_15: distribution.recipient_fee_15,
        total_amount: amount,
        locked_amount,
        fee_amount_15,
        fee_amount_6,
    });
    Ok(())
}

/// Dépôt en jetons : transferts du déposant (coffre, parrain, plateforme) et fiche.
fn open_token_distribution(
    ctx: Context<InitializeTokenDistribution>,
    payment_id: u64,
    amount: u64,
    (fee_amount_15, fee_amount_6, locked_amount): (u64, u64, u64),
) -> Result<()> {
    require_distinct_participants(
        ctx.accounts.funder.key(),
        ctx.accounts.recipient_locked.key(),
    )?;

    let accounts = &ctx.accounts;
    let token_program = accounts.token_program.to_account_info();
    let funder_token = accounts.funder_token.to_account_info();
    let funder = accounts.funder.to_account_info();
    token_transfer_from_funder(
        funder_token.clone(),
        &accounts.mint,
        accounts.vault.to_account_info(),
        funder.clone(),
        token_program.clone(),
        locked_amount,
    )?;
    if fee_amount_15 > 0 {
        token_transfer_from_funder(
            funder_token.clone(),
            &accounts.mint,
            accounts.recipient_fee_15_token.to_account_info(),
            funder.clone(),
            token_program.clone(),
            fee_amount_15,
        )?;
    }
    if fee_amount_6 > 0 {
        token_transfer_from_funder(
            funder_token,
            &accounts.mint,
            accounts.platform_token.to_account_info(),
            funder,
            token_program,
            fee_amount_6,
        )?;
    }

    let mint = ctx.accounts.mint.key();
    let vault = ctx.accounts.vault.key();
    let distribution = &mut ctx.accounts.distribution;
    distribution.payment_id = payment_id;
    distribution.payer = ctx.accounts.payer.key();
    distribution.funder = ctx.accounts.funder.key();
    distribution.mint = mint;
    distribution.recipient_locked = ctx.accounts.recipient_locked.key();
    distribution.recipient_fee_15 = ctx.accounts.recipient_fee_15.key();
    distribution.recipient_fee_6 = PLATFORM_TREASURY;
    distribution.total_amount = amount;
    distribution.locked_amount = locked_amount;
    distribution.fee_amount_15 = fee_amount_15;
    distribution.fee_amount_6 = fee_amount_6;
    distribution.vault = vault;
    distribution.vault_bump = ctx.bumps.vault;
    distribution.votes = Votes::default();
    distribution.cancelled = false;
    distribution.released = false;
    distribution.bump = ctx.bumps.distribution;

    emit!(DistributionCreated {
        payment_id,
        distribution: distribution.key(),
        mint: Some(mint),
        vault,
        funder: distribution.funder,
        recipient_locked: distribution.recipient_locked,
        recipient_fee_15: distribution.recipient_fee_15,
        total_amount: amount,
        locked_amount,
        fee_amount_15,
        fee_amount_6,
    });
    Ok(())
}

#[program]
pub mod anchor_workspace {
    use super::*;

    // ===================== Séquestre en SOL =====================

    /// Dépôt en SOL aux montants exacts : `platform_fee` (plateforme) et `sponsor_fee` (parrain), en lamports, autorisés
    /// par la signature du compte plateforme (payer) ; le reste du dépôt est séquestré pour le vendeur.
    pub fn initialize_distribution_exact(
        ctx: Context<InitializeDistribution>,
        payment_id: u64,
        amount: u64,
        platform_fee: u64,
        sponsor_fee: u64,
    ) -> Result<()> {
        require_platform_payer(ctx.accounts.payer.key())?;
        let split = exact_split(amount, platform_fee, sponsor_fee)?;
        open_sol_distribution(ctx, payment_id, amount, split)
    }

    /// Vote de l'acheteur, du vendeur ou de l'arbitre. Au deuxième vote identique, les fonds partent.
    pub fn vote_distribution(ctx: Context<VoteDistribution>, decision: u8) -> Result<()> {
        let voter = ctx.accounts.voter.key();
        let distribution = &mut ctx.accounts.distribution;
        require_open(distribution.released, distribution.cancelled)?;
        let (funder, recipient_locked) = (distribution.funder, distribution.recipient_locked);
        distribution
            .votes
            .cast(voter, funder, recipient_locked, decision)?;
        emit!(VoteCast {
            distribution: distribution.key(),
            voter,
            decision
        });

        let Some(outcome) = distribution.votes.outcome() else {
            return Ok(());
        };

        let amount = ctx.accounts.vault.to_account_info().lamports();
        require!(
            amount >= distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let destination = if outcome == VOTE_RELEASE {
            ctx.accounts.recipient_locked.to_account_info()
        } else {
            ctx.accounts.funder.to_account_info()
        };
        // La part séquestrée au destinataire, la rente du coffre au payeur du dépôt.
        let amount = distribution.locked_amount;
        settle_sol_vault(
            distribution,
            ctx.accounts.vault.to_account_info(),
            destination,
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            amount,
        )?;

        if outcome == VOTE_RELEASE {
            distribution.released = true;
        } else {
            distribution.cancelled = true;
        }
        emit!(DistributionSettled {
            distribution: distribution.key(),
            outcome,
            amount
        });
        Ok(())
    }

    // ===================== Séquestre en jetons (USDC, EURC) =====================

    /// Dépôt en jetons (USDC, EURC) aux montants exacts (unités du jeton), autorisés par la signature du compte
    /// plateforme.
    pub fn initialize_token_distribution_exact(
        ctx: Context<InitializeTokenDistribution>,
        payment_id: u64,
        amount: u64,
        platform_fee: u64,
        sponsor_fee: u64,
    ) -> Result<()> {
        require_platform_payer(ctx.accounts.payer.key())?;
        let split = exact_split(amount, platform_fee, sponsor_fee)?;
        open_token_distribution(ctx, payment_id, amount, split)
    }

    /// Vote sur un dépôt en jetons. Au deuxième vote identique, les jetons partent et le coffre est fermé.
    pub fn vote_token_distribution(
        ctx: Context<VoteTokenDistribution>,
        decision: u8,
    ) -> Result<()> {
        let voter = ctx.accounts.voter.key();
        {
            let distribution = &mut ctx.accounts.distribution;
            require_open(distribution.released, distribution.cancelled)?;
            let (funder, recipient_locked) = (distribution.funder, distribution.recipient_locked);
            distribution
                .votes
                .cast(voter, funder, recipient_locked, decision)?;
            emit!(VoteCast {
                distribution: distribution.key(),
                voter,
                decision
            });
        }

        let Some(outcome) = ctx.accounts.distribution.votes.outcome() else {
            return Ok(());
        };

        let amount = ctx.accounts.vault.amount;
        require!(
            amount >= ctx.accounts.distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let (destination, beneficiary) = if outcome == VOTE_RELEASE {
            (
                ctx.accounts.recipient_locked_token.to_account_info(),
                ctx.accounts.distribution.recipient_locked,
            )
        } else {
            (
                ctx.accounts.funder_token.to_account_info(),
                ctx.accounts.distribution.funder,
            )
        };
        require_token_destination(&destination, ctx.accounts.distribution.mint, beneficiary)?;
        let info = ctx.accounts.distribution.to_account_info();
        let token_program = ctx.accounts.token_program.to_account_info();
        token_transfer_from_vault(
            &ctx.accounts.distribution,
            info.clone(),
            ctx.accounts.vault.to_account_info(),
            &ctx.accounts.mint,
            destination,
            token_program.clone(),
            amount,
        )?;
        close_token_vault(
            &ctx.accounts.distribution,
            info,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            token_program,
        )?;

        let distribution = &mut ctx.accounts.distribution;
        if outcome == VOTE_RELEASE {
            distribution.released = true;
        } else {
            distribution.cancelled = true;
        }
        emit!(DistributionSettled {
            distribution: distribution.key(),
            outcome,
            amount
        });
        Ok(())
    }

    // ===================== Garantie (timelock) =====================

    /// Termes du dépôt signés par l'acheteur, dans la transaction du dépôt (audit P-E04) : durée de la garantie
    /// contractuelle, ou 0 si le contrat ne prévoit pas de versement automatique au vendeur. Une seule fois par dépôt.
    pub fn record_terms(ctx: Context<RecordTerms>, guarantee_seconds: u64) -> Result<()> {
        let distribution = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
        require_keys_eq!(distribution.funder, ctx.accounts.funder.key(), EscrowError::Unauthorized);
        require_open(distribution.released, distribution.cancelled)?;
        require!(
            guarantee_seconds == 0 || valid_guarantee_duration(guarantee_seconds),
            EscrowError::InvalidGuaranteeDuration
        );
        let terms = &mut ctx.accounts.terms;
        terms.distribution = ctx.accounts.distribution.key();
        terms.guarantee_seconds = guarantee_seconds;
        terms.bump = ctx.bumps.terms;
        Ok(())
    }

    /// Ouvre la période de garantie d'un dépôt (SOL ou jetons), signée par la plateforme quand le vendeur a déposé
    /// les documents. Une seule fois par dépôt : la fin ne peut être ni avancée ni repoussée. Durée au moins égale à
    /// celle signée par l'acheteur au dépôt (termes) : la clé du serveur seule ne peut pas l'écourter (audit P-E04) ;
    /// une ouverture retardée garde la durée contractuelle entière.
    pub fn start_guarantee(ctx: Context<StartGuarantee>, duration_seconds: u64) -> Result<()> {
        let agreed = ctx.accounts.terms.guarantee_seconds;
        require!(agreed > 0, EscrowError::NoAutomaticRelease);
        let duration_seconds = duration_seconds.max(agreed);
        require!(
            valid_guarantee_duration(duration_seconds),
            EscrowError::InvalidGuaranteeDuration
        );
        let distribution = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
        require_open(distribution.released, distribution.cancelled)?;
        let now = Clock::get()?.unix_timestamp;
        let lock = &mut ctx.accounts.lock;
        lock.distribution = ctx.accounts.distribution.key();
        lock.started_at = now;
        let duration = i64::try_from(duration_seconds)
            .map_err(|_| error!(EscrowError::InvalidGuaranteeDuration))?;
        lock.ends_at = now.checked_add(duration).ok_or(EscrowError::MathOverflow)?;
        lock.suspended = false;
        lock.bump = ctx.bumps.lock;
        emit!(GuaranteeStarted {
            distribution: lock.distribution,
            ends_at: lock.ends_at
        });
        Ok(())
    }

    /// Suspend la garantie (litige ouvert) : plus de versement automatique, les fonds se règlent par les votes.
    /// Signée par la plateforme, ou par l'acheteur lui-même si le serveur ne le fait pas (audit P-M02).
    pub fn suspend_guarantee(ctx: Context<SuspendGuarantee>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        if authority != PLATFORM_PAYER {
            let distribution = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
            require_keys_eq!(authority, distribution.funder, EscrowError::Unauthorized);
        }
        let lock = &mut ctx.accounts.lock;
        lock.suspended = true;
        emit!(GuaranteeSuspended {
            distribution: lock.distribution
        });
        Ok(())
    }

    /// Fin de garantie d'un dépôt en SOL : tout le coffre part au vendeur. Déclenchable par n'importe qui.
    pub fn release_after_guarantee(ctx: Context<ReleaseAfterGuarantee>) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;
        require_open(distribution.released, distribution.cancelled)?;
        require_guarantee_release(
            &ctx.accounts.lock,
            distribution.votes,
            Clock::get()?.unix_timestamp,
        )?;
        require!(
            !partial_refund_pending(&ctx.accounts.partial_refund.to_account_info()),
            EscrowError::PartialRefundPending
        );
        let amount = ctx.accounts.vault.to_account_info().lamports();
        require!(
            amount >= distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let amount = distribution.locked_amount;
        settle_sol_vault(
            distribution,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.recipient_locked.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            amount,
        )?;
        distribution.released = true;
        emit!(DistributionSettled {
            distribution: distribution.key(),
            outcome: VOTE_RELEASE,
            amount
        });
        emit!(GuaranteeReleased {
            distribution: distribution.key(),
            amount
        });
        Ok(())
    }

    /// Fin de garantie d'un dépôt en jetons : les jetons partent au vendeur, le coffre est fermé.
    pub fn release_token_after_guarantee(ctx: Context<ReleaseTokenAfterGuarantee>) -> Result<()> {
        require_open(
            ctx.accounts.distribution.released,
            ctx.accounts.distribution.cancelled,
        )?;
        require_guarantee_release(
            &ctx.accounts.lock,
            ctx.accounts.distribution.votes,
            Clock::get()?.unix_timestamp,
        )?;
        require!(
            !partial_refund_pending(&ctx.accounts.partial_refund.to_account_info()),
            EscrowError::PartialRefundPending
        );
        let amount = ctx.accounts.vault.amount;
        require!(
            amount >= ctx.accounts.distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let info = ctx.accounts.distribution.to_account_info();
        let token_program = ctx.accounts.token_program.to_account_info();
        token_transfer_from_vault(
            &ctx.accounts.distribution,
            info.clone(),
            ctx.accounts.vault.to_account_info(),
            &ctx.accounts.mint,
            ctx.accounts.recipient_locked_token.to_account_info(),
            token_program.clone(),
            amount,
        )?;
        close_token_vault(
            &ctx.accounts.distribution,
            info,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            token_program,
        )?;
        let distribution = &mut ctx.accounts.distribution;
        distribution.released = true;
        emit!(DistributionSettled {
            distribution: distribution.key(),
            outcome: VOTE_RELEASE,
            amount
        });
        emit!(GuaranteeReleased {
            distribution: distribution.key(),
            amount
        });
        Ok(())
    }

    // ===================== Remboursement partiel =====================

    /// Proposition (ou modification) du vendeur : rembourser `refund_amount` à l'acheteur, garder le reste. Modifiable
    /// tant que l'acheteur ne l'a pas acceptée. La rente du compte est payée par la plateforme (relais), comme les
    /// dépôts, et lui revient à la clôture.
    pub fn propose_partial_refund(
        ctx: Context<ProposePartialRefund>,
        refund_amount: u64,
    ) -> Result<()> {
        let terms = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
        require_open(terms.released, terms.cancelled)?;
        require_keys_eq!(
            ctx.accounts.seller.key(),
            terms.recipient_locked,
            EscrowError::Unauthorized
        );
        require_partial_amount(refund_amount, terms.locked_amount)?;
        let proposal = &mut ctx.accounts.proposal;
        if proposal.distribution == Pubkey::default() {
            proposal.distribution = ctx.accounts.distribution.key();
            proposal.bump = ctx.bumps.proposal;
        }
        require_keys_eq!(
            proposal.distribution,
            ctx.accounts.distribution.key(),
            EscrowError::InvalidDistribution
        );
        proposal.refund_amount = refund_amount;
        proposal.updated_at = Clock::get()?.unix_timestamp;
        emit!(PartialRefundProposed {
            distribution: proposal.distribution,
            refund_amount
        });
        Ok(())
    }

    /// Refus de l'acheteur : la proposition est supprimée (rente rendue à la plateforme) ; le séquestre reprend son cours.
    pub fn decline_partial_refund(ctx: Context<DeclinePartialRefund>) -> Result<()> {
        let terms = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
        require_keys_eq!(
            ctx.accounts.buyer.key(),
            terms.funder,
            EscrowError::Unauthorized
        );
        emit!(PartialRefundDeclined {
            distribution: ctx.accounts.proposal.distribution
        });
        Ok(())
    }

    /// Acceptation par l'acheteur d'un dépôt en SOL, au montant exact qu'il a lu (`expected_refund`) : la part proposée
    /// lui est versée, le reste de la part séquestrée au vendeur, la rente du coffre au payeur ; le dépôt est soldé
    /// (libéré et remboursé : partage).
    pub fn accept_partial_refund(
        ctx: Context<AcceptPartialRefund>,
        expected_refund: u64,
    ) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;
        require_open(distribution.released, distribution.cancelled)?;
        let refund_amount = ctx.accounts.proposal.refund_amount;
        require!(
            expected_refund == refund_amount,
            EscrowError::RefundAmountMismatch
        );
        require_partial_amount(refund_amount, distribution.locked_amount)?;
        let amount = ctx.accounts.vault.to_account_info().lamports();
        require!(
            amount >= distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let seller_amount = distribution
            .locked_amount
            .checked_sub(refund_amount)
            .ok_or(EscrowError::MathOverflow)?;
        let vault = ctx.accounts.vault.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        transfer_from_vault(
            distribution,
            vault.clone(),
            ctx.accounts.funder.to_account_info(),
            system_program.clone(),
            refund_amount,
        )?;
        settle_sol_vault(
            distribution,
            vault,
            ctx.accounts.recipient_locked.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            system_program,
            seller_amount,
        )?;
        distribution.released = true;
        distribution.cancelled = true;
        emit!(PartialRefundSettled {
            distribution: distribution.key(),
            refund_amount,
            seller_amount
        });
        Ok(())
    }

    /// Acceptation par l'acheteur d'un dépôt en jetons : même règle ; le coffre vide est fermé (rente au payeur du dépôt).
    pub fn accept_token_partial_refund(
        ctx: Context<AcceptTokenPartialRefund>,
        expected_refund: u64,
    ) -> Result<()> {
        require_open(
            ctx.accounts.distribution.released,
            ctx.accounts.distribution.cancelled,
        )?;
        let refund_amount = ctx.accounts.proposal.refund_amount;
        require!(
            expected_refund == refund_amount,
            EscrowError::RefundAmountMismatch
        );
        require_partial_amount(refund_amount, ctx.accounts.distribution.locked_amount)?;
        let amount = ctx.accounts.vault.amount;
        require!(
            amount >= ctx.accounts.distribution.locked_amount,
            EscrowError::InsufficientVaultFunds
        );
        let seller_amount = amount
            .checked_sub(refund_amount)
            .ok_or(EscrowError::MathOverflow)?;
        let info = ctx.accounts.distribution.to_account_info();
        let token_program = ctx.accounts.token_program.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();
        token_transfer_from_vault(
            &ctx.accounts.distribution,
            info.clone(),
            vault.clone(),
            &ctx.accounts.mint,
            ctx.accounts.funder_token.to_account_info(),
            token_program.clone(),
            refund_amount,
        )?;
        token_transfer_from_vault(
            &ctx.accounts.distribution,
            info.clone(),
            vault.clone(),
            &ctx.accounts.mint,
            ctx.accounts.recipient_locked_token.to_account_info(),
            token_program.clone(),
            seller_amount,
        )?;
        close_token_vault(
            &ctx.accounts.distribution,
            info,
            vault,
            ctx.accounts.payer.to_account_info(),
            token_program,
        )?;
        let distribution = &mut ctx.accounts.distribution;
        distribution.released = true;
        distribution.cancelled = true;
        emit!(PartialRefundSettled {
            distribution: distribution.key(),
            refund_amount,
            seller_amount
        });
        Ok(())
    }

    /// Proposition devenue sans objet (dépôt soldé autrement : votes ou garantie) : supprimée, rente rendue à son
    /// payeur. Déclenchable par n'importe qui.
    pub fn close_partial_refund(ctx: Context<ClosePartialRefund>) -> Result<()> {
        let distribution = distribution_terms(&ctx.accounts.distribution.to_account_info())?;
        require!(
            distribution.released || distribution.cancelled,
            EscrowError::DistributionStillOpen
        );
        Ok(())
    }

    // ===================== Clôture =====================

    /// Dépôt soldé (SOL ou jetons ; coffre déjà vidé ou fermé au règlement) : fiche, termes, garantie et proposition
    /// éventuelle fermés, rente rendue au payeur du dépôt. Signée par la plateforme seule, qui choisit le moment (après
    /// sa durée de conservation) : un tiers ne peut pas faire disparaître la fiche avant que le serveur l'ait relue.
    pub fn close_distribution(ctx: Context<CloseDistribution>) -> Result<()> {
        let distribution_info = ctx.accounts.distribution.to_account_info();
        let distribution = distribution_terms(&distribution_info)?;
        require!(
            distribution.released || distribution.cancelled,
            EscrowError::DistributionStillOpen
        );
        require_keys_eq!(
            ctx.accounts.payer.key(),
            distribution.payer,
            EscrowError::Unauthorized
        );
        let payer = ctx.accounts.payer.to_account_info();
        for account in [
            ctx.accounts.terms.to_account_info(),
            ctx.accounts.lock.to_account_info(),
            ctx.accounts.partial_refund.to_account_info(),
        ] {
            if program_account_exists(&account) {
                close_program_account(&account, &payer)?;
            }
        }
        close_program_account(&distribution_info, &payer)?;
        emit!(DistributionClosed {
            distribution: distribution_info.key()
        });
        Ok(())
    }
}

// ===================== Comptes : SOL =====================

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct InitializeDistribution<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PaymentDistribution::INIT_SPACE,
        seeds = [b"distribution", funder.key().as_ref(), payment_id.to_le_bytes().as_ref()],
        bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        init,
        payer = payer,
        space = 0,
        owner = system_program::ID,
        seeds = [
            b"vault",
            funder.key().as_ref(),
            payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump
    )]
    /// CHECK: coffre PDA système (owner = System Program) qui détient la part séquestrée.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub recipient_locked: SystemAccount<'info>,

    #[account(mut)]
    pub recipient_fee_15: SystemAccount<'info>,

    #[account(mut, address = PLATFORM_TREASURY @ EscrowError::InvalidFeeRecipient)]
    pub recipient_fee_6: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoteDistribution<'info> {
    #[account(
        mut,
        has_one = funder @ EscrowError::Unauthorized,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: validé par seeds + bump + owner + address.
    pub vault: UncheckedAccount<'info>,

    /// Acheteur, vendeur ou arbitre.
    pub voter: Signer<'info>,

    // Wallets des parties, contrôlés par `has_one` seulement : un virement depuis le coffre crédite n'importe quel
    // compte, et une partie qui transfère son wallet à un autre programme ne bloque pas l'issue qui la défavorise.
    /// CHECK: wallet de l'acheteur, contrôlé par `has_one`.
    #[account(mut)]
    pub funder: UncheckedAccount<'info>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one`.
    #[account(mut)]
    pub recipient_locked: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Payeur du dépôt (la plateforme) : reçoit la rente du coffre (audit SC-02).
    /// CHECK: payeur du dépôt, contrôlé par `has_one` ; crédité quel que soit son propriétaire (audit C1).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

// ===================== Comptes : jetons =====================

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct InitializeTokenDistribution<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + TokenDistribution::INIT_SPACE,
        seeds = [b"token_distribution", funder.key().as_ref(), payment_id.to_le_bytes().as_ref()],
        bump
    )]
    pub distribution: Box<Account<'info, TokenDistribution>>,

    #[account(constraint = is_allowed_mint(&mint.key()) @ EscrowError::UnsupportedMint)]
    pub mint: Box<Account<'info, Mint>>,

    /// Coffre : compte de jetons dont la fiche est propriétaire.
    #[account(
        init,
        payer = payer,
        seeds = [b"token_vault", distribution.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = distribution
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub funder: Signer<'info>,

    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: wallet du vendeur, simplement enregistré comme bénéficiaire.
    pub recipient_locked: UncheckedAccount<'info>,

    /// CHECK: wallet du parrain, propriétaire du compte de jetons ci-dessous.
    pub recipient_fee_15: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient_fee_15
    )]
    pub recipient_fee_15_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: trésorerie de la plateforme imposée (destinataire des frais de plateforme).
    #[account(address = PLATFORM_TREASURY @ EscrowError::InvalidFeeRecipient)]
    pub platform: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = platform
    )]
    pub platform_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoteTokenDistribution<'info> {
    #[account(
        mut,
        has_one = funder @ EscrowError::Unauthorized,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = mint @ EscrowError::InvalidDistribution,
        has_one = vault @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"token_distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Box<Account<'info, TokenDistribution>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Acheteur, vendeur ou arbitre (modifiable : appels construits avant cette version).
    #[account(mut)]
    pub voter: Signer<'info>,

    /// CHECK: wallet de l'acheteur, contrôlé par `has_one`.
    pub funder: UncheckedAccount<'info>,

    // Comptes de jetons des parties : seul celui du bénéficiaire de l'issue est lu et contrôlé, au versement
    // (`require_token_destination`) ; il doit exister (créé d'avance par la plateforme). Celui de l'autre partie n'est
    // pas touché : une partie qui change le propriétaire de son compte ne bloque pas l'issue qui la défavorise.
    /// CHECK: compte de jetons de l'acheteur, contrôlé au versement s'il est le destinataire.
    #[account(mut)]
    pub funder_token: UncheckedAccount<'info>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one`.
    pub recipient_locked: UncheckedAccount<'info>,

    /// CHECK: compte de jetons du vendeur, contrôlé au versement s'il est le destinataire.
    #[account(mut)]
    pub recipient_locked_token: UncheckedAccount<'info>,

    /// Reçoit la rente du coffre fermé.
    /// CHECK: payeur du dépôt, contrôlé par `has_one` (ou par l'instruction) ; crédité quel que soit son propriétaire
    /// (audit C1 : un payeur réassigné à un autre programme ne bloque aucun règlement).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ===================== Comptes : garantie =====================

#[derive(Accounts)]
pub struct StartGuarantee<'info> {
    #[account(
        init,
        payer = platform,
        space = 8 + GuaranteeLock::INIT_SPACE,
        seeds = [b"guarantee", distribution.key().as_ref()],
        bump
    )]
    pub lock: Account<'info, GuaranteeLock>,

    /// CHECK: fiche de dépôt (SOL ou jetons) de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// Termes du dépôt signés par l'acheteur : durée minimale de la garantie.
    #[account(seeds = [b"terms", distribution.key().as_ref()], bump = terms.bump)]
    pub terms: Account<'info, DepositTerms>,

    /// Compte plateforme : seul à ouvrir une garantie, il en paie la rente.
    #[account(mut, address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordTerms<'info> {
    #[account(
        init,
        payer = platform,
        space = 8 + DepositTerms::INIT_SPACE,
        seeds = [b"terms", distribution.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, DepositTerms>,

    /// CHECK: fiche de dépôt (SOL ou jetons) de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// Acheteur (déposant) : seul à fixer les termes de son dépôt.
    pub funder: Signer<'info>,

    /// Compte plateforme : paie la rente des termes.
    #[account(mut, address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SuspendGuarantee<'info> {
    #[account(mut, seeds = [b"guarantee", lock.distribution.as_ref()], bump = lock.bump)]
    pub lock: Account<'info, GuaranteeLock>,

    /// CHECK: fiche du dépôt de cette garantie, lue par `distribution_terms` (déposant).
    #[account(address = lock.distribution @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// Plateforme, ou acheteur (déposant) de ce dépôt.
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReleaseAfterGuarantee<'info> {
    #[account(
        mut,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: validé par seeds + bump + owner + address.
    pub vault: UncheckedAccount<'info>,

    #[account(seeds = [b"guarantee", distribution.key().as_ref()], bump = lock.bump)]
    pub lock: Account<'info, GuaranteeLock>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one` (crédité quel que soit son propriétaire).
    #[account(mut)]
    pub recipient_locked: UncheckedAccount<'info>,

    /// N'importe quel compte (en pratique la plateforme, qui paie les frais réseau).
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: adresse de la proposition de remboursement partiel du dépôt (seeds) ; en attente, elle bloque le versement.
    /// En dernier : les appels construits avant cette version restent décodés dans le même ordre.
    #[account(seeds = [b"partial_refund", distribution.key().as_ref()], bump)]
    pub partial_refund: UncheckedAccount<'info>,

    /// Payeur du dépôt (la plateforme) : reçoit la rente du coffre (audit SC-02).
    /// CHECK: payeur du dépôt, contrôlé par `has_one` ; crédité quel que soit son propriétaire (audit C1).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ReleaseTokenAfterGuarantee<'info> {
    #[account(
        mut,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = mint @ EscrowError::InvalidDistribution,
        has_one = vault @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"token_distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Box<Account<'info, TokenDistribution>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [b"guarantee", distribution.key().as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, GuaranteeLock>>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one`.
    pub recipient_locked: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = recipient_locked
    )]
    pub recipient_locked_token: Box<Account<'info, TokenAccount>>,

    /// Reçoit la rente du coffre fermé.
    /// CHECK: payeur du dépôt, contrôlé par `has_one` (ou par l'instruction) ; crédité quel que soit son propriétaire
    /// (audit C1 : un payeur réassigné à un autre programme ne bloque aucun règlement).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    /// N'importe quel compte (en pratique la plateforme) ; paie la création du compte de jetons du vendeur.
    #[account(mut)]
    pub caller: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: adresse de la proposition de remboursement partiel du dépôt (seeds) ; en attente, elle bloque le versement.
    #[account(seeds = [b"partial_refund", distribution.key().as_ref()], bump)]
    pub partial_refund: UncheckedAccount<'info>,
}

// ===================== Comptes : remboursement partiel =====================

#[derive(Accounts)]
pub struct ProposePartialRefund<'info> {
    #[account(
        init_if_needed,
        payer = platform,
        space = 8 + PartialRefund::INIT_SPACE,
        seeds = [b"partial_refund", distribution.key().as_ref()],
        bump
    )]
    pub proposal: Account<'info, PartialRefund>,

    /// CHECK: fiche de dépôt (SOL ou jetons) de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// Vendeur du dépôt (contrôlé dans l'instruction).
    pub seller: Signer<'info>,

    /// Compte plateforme : paie la rente de la proposition (relais), qui lui revient à la clôture.
    #[account(mut, address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeclinePartialRefund<'info> {
    #[account(
        mut,
        seeds = [b"partial_refund", distribution.key().as_ref()],
        bump = proposal.bump,
        has_one = distribution @ EscrowError::InvalidDistribution,
        close = platform
    )]
    pub proposal: Account<'info, PartialRefund>,

    /// CHECK: fiche de dépôt de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// Acheteur du dépôt (contrôlé dans l'instruction).
    pub buyer: Signer<'info>,

    /// CHECK: compte plateforme, reçoit la rente de la proposition.
    #[account(mut, address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptPartialRefund<'info> {
    #[account(
        mut,
        has_one = funder @ EscrowError::Unauthorized,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: validé par seeds + bump + owner + address.
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"partial_refund", distribution.key().as_ref()],
        bump = proposal.bump,
        has_one = distribution @ EscrowError::InvalidDistribution,
        close = payer
    )]
    pub proposal: Account<'info, PartialRefund>,

    /// Acheteur : signe l'acceptation et reçoit la part remboursée.
    #[account(mut)]
    pub funder: Signer<'info>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one` (crédité quel que soit son propriétaire).
    #[account(mut)]
    pub recipient_locked: UncheckedAccount<'info>,

    /// Payeur du dépôt (la plateforme) : reçoit la rente de la proposition.
    /// CHECK: payeur du dépôt, contrôlé par `has_one` (ou par l'instruction) ; crédité quel que soit son propriétaire
    /// (audit C1 : un payeur réassigné à un autre programme ne bloque aucun règlement).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptTokenPartialRefund<'info> {
    #[account(
        mut,
        has_one = funder @ EscrowError::Unauthorized,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        has_one = mint @ EscrowError::InvalidDistribution,
        has_one = vault @ EscrowError::Unauthorized,
        has_one = payer @ EscrowError::Unauthorized,
        seeds = [b"token_distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Box<Account<'info, TokenDistribution>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"partial_refund", distribution.key().as_ref()],
        bump = proposal.bump,
        has_one = distribution @ EscrowError::InvalidDistribution,
        close = payer
    )]
    pub proposal: Box<Account<'info, PartialRefund>>,

    /// Acheteur : signe l'acceptation ; paie la création des comptes de jetons manquants.
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = mint,
        associated_token::authority = funder
    )]
    pub funder_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: wallet du vendeur, contrôlé par `has_one`.
    pub recipient_locked: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = mint,
        associated_token::authority = recipient_locked
    )]
    pub recipient_locked_token: Box<Account<'info, TokenAccount>>,

    /// Payeur du dépôt (la plateforme) : reçoit la rente du coffre fermé et de la proposition.
    /// CHECK: payeur du dépôt, contrôlé par `has_one` (ou par l'instruction) ; crédité quel que soit son propriétaire
    /// (audit C1 : un payeur réassigné à un autre programme ne bloque aucun règlement).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePartialRefund<'info> {
    #[account(
        mut,
        seeds = [b"partial_refund", distribution.key().as_ref()],
        bump = proposal.bump,
        has_one = distribution @ EscrowError::InvalidDistribution,
        close = platform
    )]
    pub proposal: Account<'info, PartialRefund>,

    /// CHECK: fiche de dépôt de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    /// CHECK: compte plateforme, reçoit la rente de la proposition.
    #[account(mut, address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: UncheckedAccount<'info>,

    /// N'importe quel compte (en pratique la plateforme).
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseDistribution<'info> {
    /// CHECK: fiche de dépôt (SOL ou jetons) de ce programme, vérifiée par `owner` puis par `distribution_terms`.
    #[account(mut, owner = crate::ID @ EscrowError::InvalidDistribution)]
    pub distribution: UncheckedAccount<'info>,

    // Comptes rattachés au dépôt (seeds), fermés seulement s'ils existent : un dépôt sans garantie ni proposition se
    // ferme aussi.
    /// CHECK: termes du dépôt, à l'adresse imposée par les seeds.
    #[account(mut, seeds = [b"terms", distribution.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,

    /// CHECK: garantie du dépôt, à l'adresse imposée par les seeds.
    #[account(mut, seeds = [b"guarantee", distribution.key().as_ref()], bump)]
    pub lock: UncheckedAccount<'info>,

    /// CHECK: proposition de remboursement partiel du dépôt, à l'adresse imposée par les seeds.
    #[account(mut, seeds = [b"partial_refund", distribution.key().as_ref()], bump)]
    pub partial_refund: UncheckedAccount<'info>,

    /// Payeur du dépôt (la plateforme) : reçoit les rentes.
    /// CHECK: payeur du dépôt, contrôlé par `has_one` (ou par l'instruction) ; crédité quel que soit son propriétaire
    /// (audit C1 : un payeur réassigné à un autre programme ne bloque aucun règlement).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    /// Compte plateforme : seul à fermer un dépôt.
    #[account(address = PLATFORM_PAYER @ EscrowError::Unauthorized)]
    pub platform: Signer<'info>,
}

/// Période de garantie d'un dépôt (compte distinct : les fiches existantes gardent leur format).
#[account]
#[derive(InitSpace)]
pub struct GuaranteeLock {
    pub distribution: Pubkey,
    pub started_at: i64,
    pub ends_at: i64,
    pub suspended: bool,
    pub bump: u8,
}

/// Termes d'un dépôt signés par l'acheteur (compte distinct : les fiches existantes gardent leur format).
#[account]
#[derive(InitSpace)]
pub struct DepositTerms {
    pub distribution: Pubkey,
    /// Durée contractuelle de la garantie, en secondes ; 0 : pas de versement automatique au vendeur.
    pub guarantee_seconds: u64,
    pub bump: u8,
}

/// Proposition de remboursement partiel d'un dépôt (compte distinct : les fiches existantes gardent leur format).
#[account]
#[derive(InitSpace)]
pub struct PartialRefund {
    pub distribution: Pubkey,
    pub refund_amount: u64,
    pub updated_at: i64,
    pub bump: u8,
}

// ===================== Fiches de dépôt =====================

/// Fiche d'un dépôt en SOL.
#[account]
#[derive(InitSpace)]
pub struct PaymentDistribution {
    pub payment_id: u64,
    pub payer: Pubkey,
    pub funder: Pubkey,
    pub recipient_locked: Pubkey,
    pub recipient_fee_15: Pubkey,
    pub recipient_fee_6: Pubkey,
    pub total_amount: u64,
    pub locked_amount: u64,
    pub fee_amount_15: u64,
    pub fee_amount_6: u64,
    pub vault: Pubkey,
    pub vault_bump: u8,
    pub votes: Votes,
    pub cancelled: bool,
    pub released: bool,
    pub bump: u8,
}

/// Fiche d'un dépôt en jetons : même contenu, plus le jeton (mint).
#[account]
#[derive(InitSpace)]
pub struct TokenDistribution {
    pub payment_id: u64,
    pub payer: Pubkey,
    pub funder: Pubkey,
    pub mint: Pubkey,
    pub recipient_locked: Pubkey,
    pub recipient_fee_15: Pubkey,
    pub recipient_fee_6: Pubkey,
    pub total_amount: u64,
    pub locked_amount: u64,
    pub fee_amount_15: u64,
    pub fee_amount_6: u64,
    pub vault: Pubkey,
    pub vault_bump: u8,
    pub votes: Votes,
    pub cancelled: bool,
    pub released: bool,
    pub bump: u8,
}

// ===================== Événements =====================

#[event]
pub struct DistributionCreated {
    pub payment_id: u64,
    pub distribution: Pubkey,
    pub mint: Option<Pubkey>,
    pub vault: Pubkey,
    pub funder: Pubkey,
    pub recipient_locked: Pubkey,
    pub recipient_fee_15: Pubkey,
    pub total_amount: u64,
    pub locked_amount: u64,
    pub fee_amount_15: u64,
    pub fee_amount_6: u64,
}

#[event]
pub struct VoteCast {
    pub distribution: Pubkey,
    pub voter: Pubkey,
    pub decision: u8,
}

#[event]
pub struct DistributionSettled {
    pub distribution: Pubkey,
    pub outcome: u8,
    pub amount: u64,
}

#[event]
pub struct GuaranteeStarted {
    pub distribution: Pubkey,
    pub ends_at: i64,
}

#[event]
pub struct GuaranteeSuspended {
    pub distribution: Pubkey,
}

#[event]
pub struct GuaranteeReleased {
    pub distribution: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PartialRefundProposed {
    pub distribution: Pubkey,
    pub refund_amount: u64,
}

#[event]
pub struct PartialRefundDeclined {
    pub distribution: Pubkey,
}

#[event]
pub struct DistributionClosed {
    pub distribution: Pubkey,
}

#[event]
pub struct PartialRefundSettled {
    pub distribution: Pubkey,
    pub refund_amount: u64,
    pub seller_amount: u64,
}

// ===================== Erreurs =====================

#[error_code]
pub enum EscrowError {
    #[msg("Montant invalide")]
    InvalidAmount,
    #[msg("Action non autorisée")]
    Unauthorized,
    #[msg("Fonds déjà libérés au vendeur")]
    AlreadyReleased,
    #[msg("Fonds déjà remboursés à l'acheteur")]
    AlreadyCancelled,
    #[msg("Distribution invalide")]
    InvalidDistribution,
    #[msg("Overflow arithmétique")]
    MathOverflow,
    #[msg("Solde du coffre insuffisant")]
    InsufficientVaultFunds,
    #[msg("Destinataire des frais de plateforme invalide (trésorerie attendue)")]
    InvalidFeeRecipient,
    #[msg("Jeton non accepté (USDC ou EURC attendu)")]
    UnsupportedMint,
    #[msg("Acheteur, vendeur et arbitre doivent être trois comptes distincts")]
    InvalidParticipants,
    #[msg("Vote invalide (1 = libérer, 2 = rembourser)")]
    InvalidVote,
    #[msg("Ce signataire a déjà voté : un vote est définitif")]
    VoteAlreadyCast,
    #[msg("Frais non autorisés : le dépôt doit être payé et signé par le compte plateforme")]
    UnauthorizedFeeRates,
    #[msg("Frais invalides (50 % du dépôt au plus)")]
    InvalidFeeRates,
    #[msg("Durée de garantie invalide (une heure au moins, un an au plus)")]
    InvalidGuaranteeDuration,
    #[msg("La période de garantie n'est pas terminée")]
    GuaranteeNotOver,
    #[msg("Garantie suspendue par un litige : les fonds se règlent par les votes")]
    GuaranteeSuspended,
    #[msg("Un vote « rembourser » est en attente : pas de versement automatique au vendeur")]
    RefundVotePending,
    #[msg("Remboursement partiel invalide : plus de zéro et moins que le montant séquestré")]
    InvalidRefundAmount,
    #[msg("Le montant proposé a changé : relisez la proposition avant de l'accepter")]
    RefundAmountMismatch,
    #[msg("Une proposition de remboursement partiel est en attente : pas de versement automatique au vendeur")]
    PartialRefundPending,
    #[msg("Le dépôt n'est pas soldé")]
    DistributionStillOpen,
    #[msg("Compte de jetons du bénéficiaire invalide : il doit être du jeton du dépôt et lui appartenir")]
    InvalidTokenDestination,
    #[msg("Le contrat de ce dépôt ne prévoit pas de versement automatique au vendeur")]
    NoAutomaticRelease,
}

#[cfg(all(test, not(feature = "test-treasury")))]
mod tests {
    use super::*;

    // Garantie d'au moins 24 heures : la clé du serveur ne peut pas verser au vendeur sans délai de contestation.
    #[test]
    fn garantie_de_24_heures_au_moins_un_an_au_plus() {
        assert!(!valid_guarantee_duration(0));
        assert!(!valid_guarantee_duration(3_600));
        assert!(!valid_guarantee_duration(24 * 3_600 - 1));
        assert!(valid_guarantee_duration(24 * 3_600));
        assert!(valid_guarantee_duration(365 * 24 * 3_600));
        assert!(!valid_guarantee_duration(365 * 24 * 3_600 + 1));
    }

    // Jetons acceptés = adresses publiées par Circle (developers.circle.com, relevées le 5 novembre 2026). USDC change
    // d'adresse selon le réseau ; EURC a la même sur devnet et mainnet : un recoupement des deux listes est donc normal,
    // seul l'USDC devnet ne doit jamais se trouver dans un binaire mainnet (et inversement).
    #[test]
    fn jetons_acceptes_conformes_a_circle() {
        let usdc_mainnet = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        let usdc_devnet = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
        let eurc = pubkey!("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr");
        #[cfg(feature = "mainnet")]
        let (usdc, other_usdc) = (usdc_mainnet, usdc_devnet);
        #[cfg(not(feature = "mainnet"))]
        let (usdc, other_usdc) = (usdc_devnet, usdc_mainnet);
        assert_eq!(ALLOWED_MINTS, [usdc, eurc]);
        assert!(!is_allowed_mint(&other_usdc));
    }
}

// Réseau du build explicite (audit A12), exactement une feature : sans elle, un build mainnet oublié embarquerait les
// clés et jetons du devnet sous la même adresse de programme. `anchor build -- --features devnet` ou
// `anchor build -- --features mainnet`. Placé en fin de fichier : les numéros de ligne des erreurs, inscrits dans le
// binaire, ne bougent pas.
#[cfg(not(any(feature = "devnet", feature = "mainnet", feature = "idl-build")))]
compile_error!("Réseau du build à choisir : --features devnet ou --features mainnet.");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("Les features « devnet » et « mainnet » sont incompatibles : un seul réseau par build.");

// Contact de sécurité inscrit dans le binaire (section `.security.txt`), affiché par les explorateurs. Politique de
// signalement : https://actuarus.io/security.txt (RFC 9116). Absent des builds utilisés comme dépendance (CPI).
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "ACTUARUS",
    project_url: "https://actuarus.io",
    contacts: "email:contact@actuarus.io,link:https://actuarus.io/security.txt",
    policy: "https://actuarus.io/security.txt",
    preferred_languages: "fr,en",
    source_code: "https://github.com/Actuarus/escrow-program",
    auditors: "AMJI CONCEPT"
}
