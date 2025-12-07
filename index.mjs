import { ObjectId } from 'mongodb';

// src/errors.ts
var AccountingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountingError";
  }
};
var ValidationError = class extends AccountingError {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
var AccountNotFoundError = class extends AccountingError {
  constructor(key) {
    super(`Account not found with key: ${key}`);
    this.name = "AccountNotFoundError";
  }
};
var DoubleEntryError = class extends AccountingError {
  constructor(message) {
    super(message);
    this.name = "DoubleEntryError";
  }
};
var DatabaseError = class extends AccountingError {
  constructor(originalError) {
    super(originalError.message || "Database error occurred");
    this.name = "DatabaseError";
    this.stack = originalError.stack;
  }
};

// src/utils.ts
async function execute(operation) {
  try {
    return await operation();
  } catch (err) {
    if (err.name === "MongoError" || err.name === "MongoServerError") {
      throw new DatabaseError(err);
    }
    throw err;
  }
}
function round(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
function sessionOptions(ctx) {
  return ctx.session ? { session: ctx.session } : {};
}
var JOURNAL_COLLECTION = "acct_journals";
var TX_COLLECTION = "acct_transactions";
var ACCT_COLLECTION = "acct_accounts";
function postJournal(data, ctx) {
  return execute(async () => {
    if (!data.lines || data.lines.length < 2) {
      throw new ValidationError("Journal must have at least two lines");
    }
    if (!data.datetime) throw new ValidationError("Date is required");
    if (!data.memo) throw new ValidationError("Memo is required");
    let totalDebit = 0;
    let totalCredit = 0;
    const accountKeys = /* @__PURE__ */ new Set();
    data.lines.forEach((line, idx) => {
      const debit = line.debit || 0;
      const credit = line.credit || 0;
      if (debit < 0 || credit < 0) {
        throw new ValidationError(`Line ${idx}: Amounts cannot be negative`);
      }
      if (debit === 0 && credit === 0) {
        throw new ValidationError(`Line ${idx}: Line must have a non-zero debit or credit`);
      }
      if (debit > 0 && credit > 0) {
        throw new ValidationError(`Line ${idx}: Line cannot have both debit and credit`);
      }
      totalDebit += debit;
      totalCredit += credit;
      accountKeys.add(line.accountKey);
    });
    if (round(totalDebit) !== round(totalCredit)) {
      throw new DoubleEntryError(
        `Journal is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`
      );
    }
    const accounts = await ctx.db.collection(ACCT_COLLECTION).find({ key: { $in: Array.from(accountKeys) } }, { session: ctx.session }).toArray();
    const accountMap = /* @__PURE__ */ new Map();
    accounts.forEach((a) => accountMap.set(a.key, a));
    const missingKeys = Array.from(accountKeys).filter((k) => !accountMap.has(k));
    if (missingKeys.length > 0) {
      throw new AccountNotFoundError(missingKeys.join(", "));
    }
    const inactive = accounts.filter((a) => !a.isActive);
    if (inactive.length > 0) {
      throw new ValidationError(`Cannot post to inactive accounts: ${inactive.map((a) => a.key).join(", ")}`);
    }
    const now = /* @__PURE__ */ new Date();
    const journalId = new ObjectId();
    const journalDoc = {
      _id: journalId,
      memo: data.memo,
      datetime: data.datetime,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      voided: false,
      createdAt: now,
      updatedAt: now
    };
    const transactionDocs = data.lines.map((line) => {
      const account = accountMap.get(line.accountKey);
      return {
        _id: new ObjectId(),
        journalId,
        accountKey: line.accountKey,
        accountCode: account.code,
        // Denormalized for reporting speed
        debit: line.debit || 0,
        credit: line.credit || 0,
        meta: line.meta,
        datetime: data.datetime,
        voided: false,
        createdAt: now,
        updatedAt: now
      };
    });
    await ctx.db.collection(JOURNAL_COLLECTION).insertOne(journalDoc, { session: ctx.session });
    await ctx.db.collection(TX_COLLECTION).insertMany(transactionDocs, { session: ctx.session });
    return {
      journal: journalDoc,
      transactions: transactionDocs
    };
  });
}
function voidJournal(journalId, reason, ctx) {
  return execute(async () => {
    const jId = new ObjectId(journalId);
    const result = await ctx.db.collection(JOURNAL_COLLECTION).findOneAndUpdate(
      { _id: jId, voided: false },
      {
        $set: {
          voided: true,
          voidReason: reason,
          updatedAt: /* @__PURE__ */ new Date()
        }
      },
      { session: ctx.session }
    );
    if (!result) {
      throw new ValidationError(`Journal not found or already voided: ${journalId}`);
    }
    await ctx.db.collection(TX_COLLECTION).updateMany(
      { journalId: jId },
      {
        $set: {
          voided: true,
          updatedAt: /* @__PURE__ */ new Date()
        }
      },
      { session: ctx.session }
    );
    return true;
  });
}
function getJournal(journalId, ctx) {
  return execute(async () => {
    const jId = new ObjectId(journalId);
    const journal = await ctx.db.collection(JOURNAL_COLLECTION).findOne(
      { _id: jId },
      { session: ctx.session }
    );
    if (!journal) return null;
    const transactions = await ctx.db.collection(TX_COLLECTION).find({ journalId: jId }, { session: ctx.session }).toArray();
    return { journal, transactions };
  });
}

// src/accounts/index.ts
var COLLECTION = "acct_accounts";
var OPENING_BALANCE_REFERENCE_TYPE = "opening_balance";
var DEFAULT_OPENING_BALANCE_ACCOUNT = {
  key: "OPENING_BALANCE_EQUITY",
  code: "3999",
  name: "Opening Balance Equity",
  type: "equity",
  parentGroup: "equity",
  group: "Opening Balance",
  origin: "dynamicSystem",
  isActive: true,
  extra: { system: true }
};
function validateAccountStructure(data) {
  if (!data.key || !data.code || !data.name || !data.type || !data.parentGroup || !data.group) {
    throw new ValidationError("Missing required account fields");
  }
  const codeInt = parseInt(data.code, 10);
  if (isNaN(codeInt)) throw new ValidationError("Account code must be numeric string");
  if (data.type === "asset" && data.code.startsWith("1")) ;
  else if (data.type === "liability" && data.code.startsWith("2")) ;
  else if (data.type === "equity" && data.code.startsWith("3")) ;
  else if (data.type === "income" && data.code.startsWith("4")) ;
  else if ((data.type === "expense" || data.type === "contra") && (data.code.startsWith("5") || data.code.startsWith("6"))) ;
  if (data.type === "asset" && data.parentGroup !== "asset") throw new ValidationError("Asset type must have asset parentGroup");
  if (data.type === "liability" && data.parentGroup !== "liability") throw new ValidationError("Liability type must have liability parentGroup");
  if (data.type === "equity" && data.parentGroup !== "equity") throw new ValidationError("Equity type must have equity parentGroup");
  if (data.type === "income" && data.parentGroup !== "income") throw new ValidationError("Income type must have income parentGroup");
  if (data.type === "expense" && data.parentGroup !== "expense") throw new ValidationError("Expense type must have expense parentGroup");
  if (data.type === "contra" && !["asset", "liability"].includes(data.parentGroup)) {
    throw new ValidationError("Contra accounts must belong to asset or liability parentGroup");
  }
}
async function validateParent(ctx, accountKey, parentKey) {
  if (!parentKey) return;
  if (accountKey === parentKey) {
    throw new ValidationError("Account cannot be its own parent");
  }
  const parent = await ctx.db.collection(COLLECTION).findOne({ key: parentKey }, sessionOptions(ctx));
  if (!parent) {
    throw new ValidationError(`Parent account '${parentKey}' not found`);
  }
  let currentKey = parent.parentAccountKey;
  const visited = /* @__PURE__ */ new Set([parentKey]);
  let depth = 0;
  const MAX_DEPTH = 100;
  while (currentKey) {
    if (currentKey === accountKey) {
      throw new ValidationError(`Circular dependency detected. Account '${accountKey}' is an ancestor of '${parentKey}'`);
    }
    if (visited.has(currentKey)) {
      break;
    }
    visited.add(currentKey);
    const node = await ctx.db.collection(COLLECTION).findOne(
      { key: currentKey },
      { projection: { parentAccountKey: 1 }, ...sessionOptions(ctx) }
    );
    if (!node) break;
    currentKey = node.parentAccountKey;
    depth++;
    if (depth > MAX_DEPTH) break;
  }
}
function isDebitNormal(account) {
  return account.parentGroup === "asset" || account.parentGroup === "expense" || account.type === "contra" && account.parentGroup === "liability";
}
async function ensureOpeningBalanceOffsetAccount(ctx, offsetKey) {
  const keyToLookup = offsetKey || DEFAULT_OPENING_BALANCE_ACCOUNT.key;
  const existing = await ctx.db.collection(COLLECTION).findOne({ key: keyToLookup }, sessionOptions(ctx));
  if (existing) return existing;
  if (offsetKey) {
    throw new ValidationError(`Offset account '${offsetKey}' not found`);
  }
  const now = /* @__PURE__ */ new Date();
  const doc = {
    _id: new ObjectId(),
    ...DEFAULT_OPENING_BALANCE_ACCOUNT,
    createdAt: now,
    updatedAt: now
  };
  await ctx.db.collection(COLLECTION).insertOne(doc, sessionOptions(ctx));
  return doc;
}
async function voidExistingOpeningBalance(accountKey, ctx) {
  const existing = await ctx.db.collection("acct_journals").findOne(
    {
      referenceType: OPENING_BALANCE_REFERENCE_TYPE,
      referenceId: accountKey,
      voided: false
    },
    sessionOptions(ctx)
  );
  if (existing) {
    await voidJournal(existing._id, "Updated opening balance", ctx);
  }
}
function createAccount(data, ctx) {
  return execute(async () => {
    if (!data) throw new ValidationError("Data object is required");
    validateAccountStructure(data);
    if (data.parentAccountKey) {
      const parent = await ctx.db.collection(COLLECTION).findOne({ key: data.parentAccountKey }, sessionOptions(ctx));
      if (!parent) {
        throw new ValidationError(`Parent account '${data.parentAccountKey}' not found`);
      }
    }
    const existing = await ctx.db.collection(COLLECTION).findOne(
      { $or: [{ key: data.key }, { code: data.code }] },
      sessionOptions(ctx)
    );
    if (existing) {
      throw new ValidationError(`Account with key '${data.key}' or code '${data.code}' already exists`);
    }
    const now = /* @__PURE__ */ new Date();
    const doc = {
      _id: new ObjectId(),
      ...data,
      origin: data.origin,
      // Cast required due to Input logic omitting systemSeeded
      parentAccountKey: data.parentAccountKey || null,
      extra: data.extra || {},
      // Default to empty object if not provided, ensuring consistency
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    await ctx.db.collection(COLLECTION).insertOne(doc, sessionOptions(ctx));
    return doc;
  });
}
function updateAccount(data, ctx) {
  return execute(async () => {
    if (!data) throw new ValidationError("Data object is required");
    if (!data.key) throw new ValidationError("Account key is required for update");
    const updateFields = { updatedAt: /* @__PURE__ */ new Date() };
    if (data.name !== void 0) updateFields.name = data.name;
    if (data.group !== void 0) updateFields.group = data.group;
    if (data.isActive !== void 0) updateFields.isActive = data.isActive;
    if (data.extra !== void 0) updateFields.extra = data.extra;
    if (data.parentAccountKey !== void 0) {
      await validateParent(ctx, data.key, data.parentAccountKey);
      updateFields.parentAccountKey = data.parentAccountKey;
    }
    const result = await ctx.db.collection(COLLECTION).findOneAndUpdate(
      { key: data.key },
      { $set: updateFields },
      { ...sessionOptions(ctx), returnDocument: "after" }
    );
    if (!result) {
      throw new AccountNotFoundError(data.key);
    }
    return result;
  });
}
function deactivateAccount(key, ctx) {
  return updateAccount({ key, isActive: false }, ctx);
}
function getAccountByKey(key, ctx) {
  return execute(async () => {
    return ctx.db.collection(COLLECTION).findOne({ key }, sessionOptions(ctx));
  });
}
function getAccountByCode(code, ctx) {
  return execute(async () => {
    return ctx.db.collection(COLLECTION).findOne({ code }, sessionOptions(ctx));
  });
}
function listAccounts(filter, ctx) {
  return execute(async () => {
    const { limit = 100, skip = 0, ...query } = filter;
    return ctx.db.collection(COLLECTION).find(query, sessionOptions(ctx)).skip(skip).limit(limit).toArray();
  });
}
function applyOpeningBalance(data, ctx) {
  return execute(async () => {
    if (!data) throw new ValidationError("Data object is required");
    if (data.amount === void 0 || data.amount === null || Number.isNaN(data.amount)) {
      throw new ValidationError("Opening balance amount is required");
    }
    const account = await ctx.db.collection(COLLECTION).findOne({ key: data.accountKey }, sessionOptions(ctx));
    if (!account) {
      throw new AccountNotFoundError(data.accountKey);
    }
    if (!account.isActive) {
      throw new ValidationError("Cannot set opening balance on inactive accounts");
    }
    await voidExistingOpeningBalance(data.accountKey, ctx);
    const amount = round(data.amount);
    if (amount === 0) return null;
    const offsetAccount = await ensureOpeningBalanceOffsetAccount(ctx, data.offsetAccountKey);
    const debitNormal = isDebitNormal(account);
    const absAmount = Math.abs(amount);
    const accountDebit = amount > 0 ? debitNormal ? absAmount : 0 : debitNormal ? 0 : absAmount;
    const accountCredit = amount > 0 ? debitNormal ? 0 : absAmount : debitNormal ? absAmount : 0;
    const memo = data.memo || `Opening balance for ${account.name}`;
    const datetime = data.datetime || /* @__PURE__ */ new Date();
    return postJournal({
      memo,
      datetime,
      referenceType: OPENING_BALANCE_REFERENCE_TYPE,
      referenceId: account.key,
      lines: [
        {
          accountKey: account.key,
          debit: round(accountDebit),
          credit: round(accountCredit),
          meta: data.meta
        },
        {
          accountKey: offsetAccount.key,
          debit: round(accountCredit),
          credit: round(accountDebit),
          meta: { ...data.meta || {}, offsetFor: account.key }
        }
      ]
    }, ctx);
  });
}
function getAccountHierarchy(ctx) {
  return execute(async () => {
    const accounts = await ctx.db.collection(COLLECTION).find({}, sessionOptions(ctx)).toArray();
    const accountMap = /* @__PURE__ */ new Map();
    accounts.forEach((acc) => {
      accountMap.set(acc.key, { ...acc, children: [] });
    });
    const roots = [];
    accounts.forEach((acc) => {
      const node = accountMap.get(acc.key);
      if (acc.parentAccountKey && accountMap.has(acc.parentAccountKey)) {
        const parent = accountMap.get(acc.parentAccountKey);
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  });
}

// src/reports/index.ts
var TX_COLLECTION2 = "acct_transactions";
var ACCT_COLLECTION2 = "acct_accounts";
var getNetBalance = (debit, credit, type, parentGroup) => {
  const isDebitNormal2 = parentGroup === "asset" || parentGroup === "expense" || type === "contra" && parentGroup === "liability";
  if (isDebitNormal2) return round(debit - credit);
  return round(credit - debit);
};
function getAccountBalance(data, ctx) {
  return execute(async () => {
    const match = {
      accountKey: data.accountKey,
      voided: false
    };
    if (data.from || data.to) {
      match.datetime = {};
      if (data.from) match.datetime.$gte = data.from;
      if (data.to) match.datetime.$lte = data.to;
    }
    if (data.metaFilter) {
      for (const [k, v] of Object.entries(data.metaFilter)) {
        match[`meta.${k}`] = v;
      }
    }
    const result = await ctx.db.collection(TX_COLLECTION2).aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          debit: { $sum: "$debit" },
          credit: { $sum: "$credit" }
        }
      }
    ], { session: ctx.session }).toArray();
    if (result.length === 0) {
      return { balance: 0, debit: 0, credit: 0 };
    }
    const { debit, credit } = result[0];
    const account = await ctx.db.collection(ACCT_COLLECTION2).findOne(
      { key: data.accountKey },
      { projection: { type: 1, parentGroup: 1 }, session: ctx.session }
    );
    if (!account) throw new Error(`Account ${data.accountKey} not found`);
    return {
      debit: round(debit),
      credit: round(credit),
      balance: getNetBalance(debit, credit, account.type, account.parentGroup)
    };
  });
}
function getAccountLedger(data, ctx) {
  return execute(async () => {
    const page = data.page || 1;
    const pageSize = data.pageSize || 50;
    const skip = (page - 1) * pageSize;
    let openingBalance = 0;
    if (data.from) {
      const preRes = await getAccountBalance({
        accountKey: data.accountKey,
        to: new Date(data.from.getTime() - 1),
        metaFilter: data.metaFilter
      }, ctx);
      openingBalance = preRes.balance;
    }
    const match = {
      accountKey: data.accountKey,
      voided: false
    };
    if (data.from || data.to) {
      match.datetime = {};
      if (data.from) match.datetime.$gte = data.from;
      if (data.to) match.datetime.$lte = data.to;
    }
    if (data.metaFilter) {
      for (const [k, v] of Object.entries(data.metaFilter)) {
        match[`meta.${k}`] = v;
      }
    }
    const items = await ctx.db.collection(TX_COLLECTION2).find(match, { session: ctx.session }).sort({ datetime: 1, _id: 1 }).skip(skip).limit(pageSize).toArray();
    const account = await ctx.db.collection(ACCT_COLLECTION2).findOne(
      { key: data.accountKey },
      { session: ctx.session }
    );
    if (!account) throw new Error("Account not found");
    let currentBalance = openingBalance;
    const ledgerItems = items.map((item) => {
      const netChange = getNetBalance(item.debit, item.credit, account.type, account.parentGroup);
      currentBalance = round(currentBalance + netChange);
      return {
        ...item,
        runningBalance: currentBalance
      };
    });
    const totalCount = await ctx.db.collection(TX_COLLECTION2).countDocuments(match, { session: ctx.session });
    return {
      items: ledgerItems,
      total: totalCount,
      page,
      pageSize
    };
  });
}
function getTrialBalance(data, ctx) {
  return execute(async () => {
    const match = { voided: false };
    if (data.from || data.to) {
      match.datetime = {};
      if (data.from) match.datetime.$gte = data.from;
      if (data.to) match.datetime.$lte = data.to;
    }
    const aggr = await ctx.db.collection(TX_COLLECTION2).aggregate([
      { $match: match },
      {
        $group: {
          _id: "$accountKey",
          totalDebit: { $sum: "$debit" },
          totalCredit: { $sum: "$credit" }
        }
      }
    ], { session: ctx.session }).toArray();
    const accounts = await ctx.db.collection(ACCT_COLLECTION2).find({}, { session: ctx.session }).toArray();
    const accountMap = new Map(accounts.map((a) => [a.key, a]));
    const lines = [];
    let grandTotalDebit = 0;
    let grandTotalCredit = 0;
    for (const row of aggr) {
      const acct = accountMap.get(row._id);
      if (!acct) continue;
      const d = round(row.totalDebit);
      const c = round(row.totalCredit);
      grandTotalDebit += d;
      grandTotalCredit += c;
      lines.push({
        accountKey: acct.key,
        accountCode: acct.code,
        accountName: acct.name,
        debit: d,
        credit: c,
        balance: getNetBalance(d, c, acct.type, acct.parentGroup)
      });
    }
    lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return {
      lines,
      totalDebit: round(grandTotalDebit),
      totalCredit: round(grandTotalCredit),
      asOf: data.to || /* @__PURE__ */ new Date()
    };
  });
}
function getProfitAndLoss(data, ctx) {
  return execute(async () => {
    const fromDate = data.from || /* @__PURE__ */ new Date(0);
    const toDate = data.to || /* @__PURE__ */ new Date();
    const accounts = await ctx.db.collection(ACCT_COLLECTION2).find({
      parentGroup: { $in: ["income", "expense"] }
    }, { session: ctx.session }).toArray();
    const accountKeys = accounts.map((a) => a.key);
    const acctMap = new Map(accounts.map((a) => [a.key, a]));
    const match = {
      accountKey: { $in: accountKeys },
      voided: false,
      datetime: { $gte: fromDate, $lte: toDate }
    };
    if (data.metaFilter) {
      for (const [k, v] of Object.entries(data.metaFilter)) {
        match[`meta.${k}`] = v;
      }
    }
    const aggr = await ctx.db.collection(TX_COLLECTION2).aggregate([
      { $match: match },
      {
        $group: {
          _id: "$accountKey",
          debit: { $sum: "$debit" },
          credit: { $sum: "$credit" }
        }
      }
    ], { session: ctx.session }).toArray();
    const incomeBreakdown = {};
    const expenseBreakdown = {};
    let totalIncome = 0;
    let totalExpense = 0;
    for (const row of aggr) {
      const acct = acctMap.get(row._id);
      const net = getNetBalance(row.debit, row.credit, acct.type, acct.parentGroup);
      if (acct.parentGroup === "income") {
        const group = acct.group || "General";
        incomeBreakdown[group] = round((incomeBreakdown[group] || 0) + net);
        totalIncome += net;
      } else if (acct.parentGroup === "expense") {
        const group = acct.group || "General";
        expenseBreakdown[group] = round((expenseBreakdown[group] || 0) + net);
        totalExpense += net;
      }
    }
    return {
      income: round(totalIncome),
      expense: round(totalExpense),
      netProfit: round(totalIncome - totalExpense),
      currency: "USD",
      from: fromDate,
      to: toDate,
      breakdown: {
        income: incomeBreakdown,
        expense: expenseBreakdown
      }
    };
  });
}
function getBalanceSheet(data, ctx) {
  return execute(async () => {
    const aggr = await ctx.db.collection(TX_COLLECTION2).aggregate([
      {
        $match: {
          voided: false,
          datetime: { $lte: data.asOf }
        }
      },
      {
        $group: {
          _id: "$accountKey",
          debit: { $sum: "$debit" },
          credit: { $sum: "$credit" }
        }
      }
    ], { session: ctx.session }).toArray();
    const accounts = await ctx.db.collection(ACCT_COLLECTION2).find({}, { session: ctx.session }).toArray();
    const acctMap = new Map(accounts.map((a) => [a.key, a]));
    const assetsBreakdown = {};
    const liabBreakdown = {};
    const equityBreakdown = {};
    let totalAssets = 0;
    let totalLiab = 0;
    let totalEquity = 0;
    let netIncome = 0;
    for (const row of aggr) {
      const acct = acctMap.get(row._id);
      if (!acct) continue;
      const net = getNetBalance(row.debit, row.credit, acct.type, acct.parentGroup);
      const group = acct.group || "General";
      if (acct.parentGroup === "asset") {
        assetsBreakdown[group] = round((assetsBreakdown[group] || 0) + net);
        totalAssets += net;
      } else if (acct.parentGroup === "liability") {
        liabBreakdown[group] = round((liabBreakdown[group] || 0) + net);
        totalLiab += net;
      } else if (acct.parentGroup === "equity") {
        equityBreakdown[group] = round((equityBreakdown[group] || 0) + net);
        totalEquity += net;
      } else if (acct.parentGroup === "income") {
        netIncome += net;
      } else if (acct.parentGroup === "expense") {
        netIncome -= net;
      }
    }
    const retainedKey = "Retained Earnings (Calc)";
    equityBreakdown[retainedKey] = round((equityBreakdown[retainedKey] || 0) + netIncome);
    totalEquity += netIncome;
    return {
      assets: round(totalAssets),
      liabilities: round(totalLiab),
      equity: round(totalEquity),
      asOf: data.asOf,
      breakdown: {
        assets: assetsBreakdown,
        liabilities: liabBreakdown,
        equity: equityBreakdown
      }
    };
  });
}
var ACCT_COLLECTION3 = "acct_accounts";
var JOURNAL_COLLECTION2 = "acct_journals";
var TX_COLLECTION3 = "acct_transactions";
function ensureAccountingIndexes(ctx) {
  return execute(async () => {
    const p1 = ctx.db.collection(ACCT_COLLECTION3).createIndexes([
      { key: { key: 1 }, unique: true },
      { key: { code: 1 }, unique: true },
      { key: { type: 1 } },
      { key: { parentGroup: 1 } }
    ], { session: ctx.session });
    const p2 = ctx.db.collection(JOURNAL_COLLECTION2).createIndexes([
      { key: { datetime: 1 } },
      { key: { referenceType: 1, referenceId: 1 } }
    ], { session: ctx.session });
    const p3 = ctx.db.collection(TX_COLLECTION3).createIndexes([
      { key: { accountKey: 1, datetime: 1 } },
      // For getting balance/ledger
      { key: { journalId: 1 } },
      // For getting journal details
      { key: { "meta.customerId": 1 }, sparse: true }
      // Example loose index
    ], { session: ctx.session });
    const results = await Promise.all([p1, p2, p3]);
    return results.flat();
  });
}
function seedAccounts(accounts, ctx) {
  return execute(async () => {
    const ops = accounts.map((acct) => ({
      updateOne: {
        filter: { key: acct.key },
        update: {
          $setOnInsert: {
            ...acct,
            _id: new ObjectId(),
            isActive: true,
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          }
        },
        upsert: true
      }
    }));
    if (ops.length > 0) {
      await ctx.db.collection(ACCT_COLLECTION3).bulkWrite(ops, { session: ctx.session });
    }
    return ctx.db.collection(ACCT_COLLECTION3).find({ key: { $in: accounts.map((a) => a.key) } }, { session: ctx.session }).toArray();
  });
}

export { AccountNotFoundError, AccountingError, DatabaseError, DoubleEntryError, ValidationError, applyOpeningBalance, createAccount, deactivateAccount, ensureAccountingIndexes, getAccountBalance, getAccountByCode, getAccountByKey, getAccountHierarchy, getAccountLedger, getBalanceSheet, getJournal, getProfitAndLoss, getTrialBalance, listAccounts, postJournal, seedAccounts, updateAccount, voidJournal };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map