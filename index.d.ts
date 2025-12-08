import { Db, ClientSession, ObjectId } from 'mongodb';

/**
 * Context for all database operations.
 */
interface AccountingDbContext {
    db: Db;
    session?: ClientSession;
}
type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'contra';
type AccountParentGroup = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
type AccountOrigin = 'systemSeeded' | 'dynamicSystem' | 'userCreated';
interface Account {
    _id: ObjectId;
    key: string;
    code: string;
    name: string;
    type: AccountType;
    parentGroup: AccountParentGroup;
    group: string;
    origin: AccountOrigin;
    isActive: boolean;
    chrStatus: string;
    parentAccountKey?: string | null;
    extra?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}
interface AccountHierarchyNode extends Account {
    children: AccountHierarchyNode[];
}
interface Journal {
    _id: ObjectId;
    memo: string;
    datetime: Date;
    referenceType?: string;
    referenceId?: string;
    chrStatus: string;
    voided: boolean;
    voidReason?: string | null;
    createdAt: Date;
    updatedAt: Date;
    [key: string]: any;
}
interface TransactionLine {
    _id: ObjectId;
    journalId: ObjectId;
    accountKey: string;
    accountCode: string;
    debit: number;
    credit: number;
    meta?: Record<string, any>;
    datetime: Date;
    chrStatus: string;
    voided: boolean;
    createdAt: Date;
    updatedAt: Date;
    [key: string]: any;
}
interface CreateAccountInput {
    key: string;
    code: string;
    name: string;
    type: AccountType;
    parentGroup: AccountParentGroup;
    group: string;
    origin: Omit<AccountOrigin, 'systemSeeded'>;
    parentAccountKey?: string;
    extra?: Record<string, any>;
}
interface UpdateAccountInput {
    key: string;
    name?: string;
    group?: string;
    isActive?: boolean;
    parentAccountKey?: string | null;
    extra?: Record<string, any>;
}
interface TransactionLineInput {
    accountKey: string;
    debit?: number;
    credit?: number;
    meta?: Record<string, any>;
    extra?: Record<string, any>;
}
interface PostJournalInput {
    memo: string;
    datetime: Date;
    referenceType?: string;
    referenceId?: string;
    lines: TransactionLineInput[];
    extra?: Record<string, any>;
    transactionExtra?: Record<string, any>;
}
interface ApplyOpeningBalanceInput {
    accountKey: string;
    amount: number;
    datetime?: Date;
    memo?: string;
    offsetAccountKey?: string;
    meta?: Record<string, any>;
}
interface PostJournalResult {
    journal: Journal;
    transactions: TransactionLine[];
}
interface AccountBalanceResult {
    balance: number;
    debit: number;
    credit: number;
}
interface AccountLedgerItem extends TransactionLine {
    runningBalance: number;
}
interface AccountLedgerResult {
    items: AccountLedgerItem[];
    total: number;
    page: number;
    pageSize: number;
}
interface TrialBalanceLine {
    accountKey: string;
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    balance: number;
}
interface TrialBalanceResult {
    lines: TrialBalanceLine[];
    totalDebit: number;
    totalCredit: number;
    asOf: Date;
}
interface ProfitAndLossResult {
    income: number;
    expense: number;
    netProfit: number;
    currency: string;
    from: Date;
    to: Date;
    breakdown: {
        income: Record<string, number>;
        expense: Record<string, number>;
    };
}
interface BalanceSheetResult {
    assets: number;
    liabilities: number;
    equity: number;
    asOf: Date;
    breakdown: {
        assets: Record<string, number>;
        liabilities: Record<string, number>;
        equity: Record<string, number>;
    };
}
interface AccountSeedInput {
    arrData: Array<Omit<Account, '_id' | 'createdAt' | 'updatedAt'>>;
    arrIndex: Array<Record<string, any>>;
}
type AccountSeed = Omit<Account, '_id' | 'createdAt' | 'updatedAt'>;

declare class AccountingError extends Error {
    constructor(message: string);
}
declare class ValidationError extends AccountingError {
    constructor(message: string);
}
declare class AccountNotFoundError extends AccountingError {
    constructor(key: string);
}
declare class DoubleEntryError extends AccountingError {
    constructor(message: string);
}
declare class DatabaseError extends AccountingError {
    constructor(originalError: any);
}

declare function createAccount(data: CreateAccountInput, ctx: AccountingDbContext): Promise<Account>;
declare function updateAccount(data: UpdateAccountInput, ctx: AccountingDbContext): Promise<Account>;
declare function deactivateAccount(key: string, ctx: AccountingDbContext): Promise<Account>;
declare function getAccountByKey(key: string, ctx: AccountingDbContext): Promise<Account | null>;
declare function getAccountByCode(code: string, ctx: AccountingDbContext): Promise<Account | null>;
declare function listAccounts(filter: Partial<Account> & {
    limit?: number;
    skip?: number;
}, ctx: AccountingDbContext): Promise<Account[]>;
declare function applyOpeningBalance(data: ApplyOpeningBalanceInput, ctx: AccountingDbContext): Promise<PostJournalResult | null>;
declare function getAccountHierarchy(ctx: AccountingDbContext): Promise<AccountHierarchyNode[]>;
declare function getChartOfAccounts(ctx: AccountingDbContext): Promise<AccountHierarchyNode[]>;
declare function getChildAccounts(identifier: string | ObjectId, ctx: AccountingDbContext): Promise<Account[]>;
declare function getParentAccounts(identifier: string | ObjectId, ctx: AccountingDbContext): Promise<Account[]>;

interface VoidJournalResult {
    journalsVoided: number;
    transactionsVoided: number;
}
declare function postJournal(data: PostJournalInput, ctx: AccountingDbContext): Promise<PostJournalResult>;
declare function voidJournal(journalId: string | ObjectId, reason: string, ctx: AccountingDbContext): Promise<boolean>;
declare function voidJournalsByIdentifier(identifier: {
    journalId?: string | ObjectId;
    referenceId?: string;
    referenceType?: string;
}, reason: string, ctx: AccountingDbContext): Promise<VoidJournalResult>;
declare function getJournal(journalId: string | ObjectId, ctx: AccountingDbContext): Promise<PostJournalResult | null>;

declare function getAccountBalance(data: {
    accountKey: string;
    from?: Date;
    to?: Date;
    metaFilter?: Record<string, any>;
}, ctx: AccountingDbContext): Promise<AccountBalanceResult>;
declare function getAccountLedger(data: {
    accountKey: string;
    from?: Date;
    to?: Date;
    metaFilter?: Record<string, any>;
    page?: number;
    pageSize?: number;
}, ctx: AccountingDbContext): Promise<AccountLedgerResult>;
declare function getTrialBalance(data: {
    from?: Date;
    to?: Date;
}, ctx: AccountingDbContext): Promise<TrialBalanceResult>;
declare function getProfitAndLoss(data: {
    from?: Date;
    to?: Date;
    metaFilter?: Record<string, any>;
}, ctx: AccountingDbContext): Promise<ProfitAndLossResult>;
declare function getBalanceSheet(data: {
    asOf: Date;
}, ctx: AccountingDbContext): Promise<BalanceSheetResult>;

declare function ensureAccountingIndexes(ctx: AccountingDbContext): Promise<string[]>;
declare function seedAccounts(accounts: AccountSeed[], ctx: AccountingDbContext): Promise<Account[]>;

export { type Account, type AccountBalanceResult, type AccountHierarchyNode, type AccountLedgerItem, type AccountLedgerResult, AccountNotFoundError, type AccountOrigin, type AccountParentGroup, type AccountSeed, type AccountSeedInput, type AccountType, type AccountingDbContext, AccountingError, type ApplyOpeningBalanceInput, type BalanceSheetResult, type CreateAccountInput, DatabaseError, DoubleEntryError, type Journal, type PostJournalInput, type PostJournalResult, type ProfitAndLossResult, type TransactionLine, type TransactionLineInput, type TrialBalanceLine, type TrialBalanceResult, type UpdateAccountInput, ValidationError, applyOpeningBalance, createAccount, deactivateAccount, ensureAccountingIndexes, getAccountBalance, getAccountByCode, getAccountByKey, getAccountHierarchy, getAccountLedger, getBalanceSheet, getChartOfAccounts, getChildAccounts, getJournal, getParentAccounts, getProfitAndLoss, getTrialBalance, listAccounts, postJournal, seedAccounts, updateAccount, voidJournal, voidJournalsByIdentifier };
