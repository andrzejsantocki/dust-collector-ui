import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { DustCollector } from "../target/types/dust_collector";
import { expect } from "chai";

describe("dust_collector", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.dustCollector as Program<DustCollector>;
  const connection = provider.connection;

  const admin = provider.wallet.publicKey;
  const payer = provider.wallet.payer;
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  // The protocol vault is a PDA created at init (rent-exempt, deterministic).
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [statsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    program.programId
  );

  // The config PDA is initialized ONCE per validator; all tests share it.
  let vault: PublicKey;

  before(async () => {
    vault = vaultPda;
    await program.methods
      .initializeConfig({
        closeFeeBps: 500, // 5% of recovered rent
        closeMinFeeLamports: new BN(0),
        closeMaxFeeLamports: new BN(100_000), // 0.0001 SOL
        swapFeeBps: 50,
        swapMaxFeeBps: 100,
        jupiterProgram: new PublicKey(
          "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        ),
      })
      .accounts({
        admin,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .initializeStats()
      .accounts({
        admin,
        config: configPda,
        stats: statsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  async function fundUser(lamports = 10 * LAMPORTS_PER_SOL) {
    const user = Keypair.generate();
    await connection.requestAirdrop(user.publicKey, lamports);
    await new Promise((r) => setTimeout(r, 500));
    return user;
  }

  async function setupToken(
    user: PublicKey,
    decimals = 6,
    balance = 0
  ): Promise<{ mint: PublicKey; ata: PublicKey }> {
    const mint = await createMint(connection, payer, admin, null, decimals);
    const ata = getAssociatedTokenAddressSync(mint, user);
    await createAssociatedTokenAccount(connection, payer, mint, user);
    if (balance > 0) {
      await mintTo(connection, payer, mint, ata, admin, balance);
    }
    return { mint, ata };
  }

  async function ataBalance(ata: PublicKey) {
    try {
      const acc = await getAccount(connection, ata);
      return Number(acc.amount);
    } catch {
      return null; // closed / not found
    }
  }

  async function expectError(promise: Promise<any>, code: string) {
    try {
      await promise;
      throw new Error(`Expected error ${code} but transaction succeeded`);
    } catch (e: any) {
      if (e.message.includes(`Expected error ${code}`)) throw e;
      const actual = e?.error?.errorCode?.code ?? e?.toString();
      expect(actual).to.contain(code, `expected error code ${code}`);
    }
  }

  function closeEmptyAccounts(user: PublicKey, mint: PublicKey, ata: PublicKey, vaultKey: PublicKey) {
    return {
      user,
      config: configPda,
      stats: statsPda,
      source: ata,
      mint,
      protocolVault: vaultKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  function burnAndCloseAccounts(user: PublicKey, mint: PublicKey, ata: PublicKey, vaultKey: PublicKey) {
    return closeEmptyAccounts(user, mint, ata, vaultKey);
  }

  // Anchor codegen makes Option fields required-but-nullable.
  function updateConfig(partial: Partial<Parameters<typeof program.methods.updateConfig>[0]>) {
    const args = {
      protocolVault: null,
      closeFeeBps: null,
      closeMinFeeLamports: null,
      closeMaxFeeLamports: null,
      swapFeeBps: null,
      swapMaxFeeBps: null,
      jupiterProgram: null,
      paused: null,
      ...partial,
    };
    return program.methods.updateConfig(args as any).accounts({ config: configPda, admin });
  }

  describe("config", () => {
    it("was initialized with conservative defaults", async () => {
      const config = await program.account.config.fetch(configPda);
      expect(config.admin.toBase58()).to.equal(admin.toBase58());
      expect(config.protocolVault.toBase58()).to.equal(vault.toBase58());
      expect(config.closeFeeBps).to.equal(500);
      expect(config.paused).to.equal(false);
    });

    it("cannot be initialized twice", async () => {
      await expectError(
        program.methods
          .initializeConfig({
            closeFeeBps: 500,
            closeMinFeeLamports: new BN(0),
            closeMaxFeeLamports: new BN(100_000),
            swapFeeBps: 50,
            swapMaxFeeBps: 100,
            jupiterProgram: new PublicKey(
              "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
            ),
          })
          .accounts({
            admin,
            config: configPda,
            vault: vaultPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "already in use"
      );
    });
  });

  describe("protocol_stats", () => {
    it("was initialized at the deterministic stats PDA", async () => {
      const stats = await program.account.protocolStats.fetch(statsPda);
      expect(stats.successfulOperations.toNumber()).to.equal(0);
      expect(stats.successfulCloses.toNumber()).to.equal(0);
      expect(stats.successfulBurns.toNumber()).to.equal(0);
      expect(stats.successfulSwaps.toNumber()).to.equal(0);
      expect(stats.totalRentRecoveredLamports.toNumber()).to.equal(0);
      expect(stats.totalCloseFeesLamports.toNumber()).to.equal(0);
    });
  });

  describe("update_config", () => {
    it("rejects non-admin updates", async () => {
      const attacker = await fundUser();
      await expectError(
        updateConfig({ paused: true }).accounts({ admin: attacker.publicKey }).signers([attacker]).rpc(),
        "Unauthorized"
      );
    });

    it("admin can update fee params", async () => {
      await updateConfig({ closeFeeBps: 100 }).rpc();
      const config = await program.account.config.fetch(configPda);
      expect(config.closeFeeBps).to.equal(100);
      // restore
      await updateConfig({ closeFeeBps: 500 }).rpc();
    });
  });

  describe("close_empty", () => {
    it("closes empty ATA, pays capped fee, recovers rent", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);

      const before = await connection.getBalance(user.publicKey);
      const rent = await connection.getMinimumBalanceForRentExemption(165);
      const vaultBefore = await connection.getBalance(vault);
      const statsBefore = await program.account.protocolStats.fetch(statsPda);

      await program.methods
        .closeEmpty(new BN(1_000_000))
        .accounts(closeEmptyAccounts(user.publicKey, mint, ata, vault))
        .signers([user])
        .rpc();

      expect(await ataBalance(ata)).to.equal(null);
      // Fee: 5% of rent, capped at 100_000 lamports
      const expectedFee = Math.min(Math.floor(rent * 0.05), 100_000);
      expect(await connection.getBalance(vault)).to.equal(vaultBefore + expectedFee);
      // User recovered rent minus fee
      const after = await connection.getBalance(user.publicKey);
      expect(after - before).to.equal(rent - expectedFee);
      const statsAfter = await program.account.protocolStats.fetch(statsPda);
      expect(statsAfter.successfulOperations.toNumber()).to.equal(
        statsBefore.successfulOperations.toNumber() + 1
      );
      expect(statsAfter.successfulCloses.toNumber()).to.equal(
        statsBefore.successfulCloses.toNumber() + 1
      );
      expect(statsAfter.totalRentRecoveredLamports.toNumber()).to.equal(
        statsBefore.totalRentRecoveredLamports.toNumber() + rent
      );
      expect(statsAfter.totalCloseFeesLamports.toNumber()).to.equal(
        statsBefore.totalCloseFeesLamports.toNumber() + expectedFee
      );
    });

    it("respects user fee cap below protocol max", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);
      const vaultBefore = await connection.getBalance(vault);

      await program.methods
        .closeEmpty(new BN(1_000)) // user authorizes at most 1000 lamports
        .accounts(closeEmptyAccounts(user.publicKey, mint, ata, vault))
        .signers([user])
        .rpc();

      expect(await connection.getBalance(vault)).to.equal(vaultBefore + 1_000);
    });

    it("rejects non-empty ATA", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey, 6, 5_000_000);

      await expectError(
        program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts(closeEmptyAccounts(user.publicKey, mint, ata, vault))
          .signers([user])
          .rpc(),
        "NotEmpty"
      );
    });

    it("rejects wrong protocol vault", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);
      const attackerVault = Keypair.generate();

      await expectError(
        program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts(closeEmptyAccounts(user.publicKey, mint, ata, attackerVault.publicKey))
          .signers([user])
          .rpc(),
        "WrongVault"
      );
    });

    it("rejects wrong mint", async () => {
      const user = await fundUser();
      const { ata } = await setupToken(user.publicKey);
      // A real, unrelated mint (the constraint fails on mint mismatch, not on
      // an uninitialized account).
      const otherMint = await createMint(connection, payer, admin, null, 6);

      await expectError(
        program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts(closeEmptyAccounts(user.publicKey, otherMint, ata, vault))
          .signers([user])
          .rpc(),
        "ConstraintTokenMint"
      );
    });

    it("rejects fake token program", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);
      const fakeProgram = Keypair.generate();

      await expectError(
        program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts({
            ...closeEmptyAccounts(user.publicKey, mint, ata, vault),
            tokenProgram: fakeProgram.publicKey,
          })
          .signers([user])
          .rpc(),
        "InvalidProgramId"
      );
    });

    it("fails while paused", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);

      await updateConfig({ paused: true }).rpc();

      await expectError(
        program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts(closeEmptyAccounts(user.publicKey, mint, ata, vault))
          .signers([user])
          .rpc(),
        "Paused"
      );

      // restore so the remaining tests run unpaused
      await updateConfig({ paused: false }).rpc();
    });
  });

  describe("batching (plan Step 12)", () => {
    it("closes 3 empty ATAs in ONE transaction with one signature", async () => {
      const user = await fundUser();
      // three different mints/ATAs for the same user
      const setups = [];
      for (let i = 0; i < 3; i++) {
        setups.push(await setupToken(user.publicKey));
      }
      const vaultBefore = await connection.getBalance(vault);

      // one transaction, three close_empty instructions, one signer
      const tx = new Transaction();
      for (const { mint, ata } of setups) {
        tx.add(
          await program.methods
            .closeEmpty(new BN(1_000_000))
            .accounts(closeEmptyAccounts(user.publicKey, mint, ata, vault))
            .instruction()
        );
      }
      await provider.sendAndConfirm(tx, [user]);

      // all three ATAs closed
      for (const { ata } of setups) {
        expect((await connection.getAccountInfo(ata))?.lamports ?? 0).to.equal(0);
      }
      // protocol fees collected for all three ops in the same tx
      const rent = await connection.getMinimumBalanceForRentExemption(165);
      const perOpFee = Math.min(Math.floor(rent * 0.05), 100_000);
      expect(await connection.getBalance(vault)).to.equal(vaultBefore + perOpFee * 3);
    });

    it("mixes close and burn ops in one transaction", async () => {
      const user = await fundUser();
      const empty = await setupToken(user.publicKey);
      const { mint, ata } = await setupToken(user.publicKey, 6, 4321); // burnable dust

      const tx = new Transaction();
      tx.add(
        await program.methods
          .closeEmpty(new BN(1_000_000))
          .accounts(closeEmptyAccounts(user.publicKey, empty.mint, empty.ata, vault))
          .instruction()
      );
      tx.add(
        await program.methods
          .burnAndClose(new BN(1_000_000))
          .accounts(burnAndCloseAccounts(user.publicKey, mint, ata, vault))
          .instruction()
      );
      await provider.sendAndConfirm(tx, [user]);

      expect((await connection.getAccountInfo(empty.ata))?.lamports ?? 0).to.equal(0);
      expect((await connection.getAccountInfo(ata))?.lamports ?? 0).to.equal(0);
    });
  });

  describe("burn_and_close", () => {
    it("burns dust, closes ATA, pays capped fee", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey, 6, 1234);
      const mintBefore = await getMint(connection, mint);

      await program.methods
        .burnAndClose(new BN(1_000_000))
        .accounts(burnAndCloseAccounts(user.publicKey, mint, ata, vault))
        .signers([user])
        .rpc();

      expect(await ataBalance(ata)).to.equal(null);
      const mintAfter = await getMint(connection, mint);
      expect(mintAfter.supply.toString()).to.equal(
        (mintBefore.supply - BigInt(1234)).toString()
      );
      expect((await connection.getBalance(vault)) > 0).to.equal(true);
    });

    it("rejects zero balance", async () => {
      const user = await fundUser();
      const { mint, ata } = await setupToken(user.publicKey);

      await expectError(
        program.methods
          .burnAndClose(new BN(1_000_000))
          .accounts(burnAndCloseAccounts(user.publicKey, mint, ata, vault))
          .signers([user])
          .rpc(),
        "Empty"
      );
    });
  });
});
