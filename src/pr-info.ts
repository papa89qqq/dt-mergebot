import { GetPRInfo } from "./queries/pr-query";
import { PR as PRQueryResult, PR_repository_pullRequest as GraphqlPullRequest,
         PR_repository_pullRequest_commits_nodes_commit,
         PR_repository_pullRequest,
         PR_repository_pullRequest_timelineItems,
         PR_repository_pullRequest_timelineItems_nodes_ReopenedEvent,
         PR_repository_pullRequest_reviews,
         PR_repository_pullRequest_timelineItems_nodes_IssueComment,
         PR_repository_pullRequest_timelineItems_nodes_ReadyForReviewEvent,
         PR_repository_pullRequest_timelineItems_nodes_MovedColumnsInProjectEvent
       } from "./queries/schema/PR";
import { CIResult } from "./util/CIResult";
import { PullRequestReviewState, CommentAuthorAssociation, CheckConclusionState } from "./queries/graphql-global-types";
import { getMonthlyDownloadCount } from "./util/npm";
import { client } from "./graphql-client";
import { ApolloQueryResult } from "apollo-boost";
import { fetchFile as defaultFetchFile } from "./util/fetchFile";
import { findLast, forEachReverse, daysSince, authorNotBot } from "./util/util";
import * as HeaderParser from "definitelytyped-header-parser";

export enum ApprovalFlags {
    None = 0,
    Other = 1 << 0,
    Owner = 1 << 1,
    Maintainer = 1 << 2
}

const CriticalPopularityThreshold = 5_000_000;
const NormalPopularityThreshold = 200_000;

export type DangerLevel =
    | "ScopedAndTested"
    | "ScopedAndUntested"
    | "ScopedAndConfiguration"
    | "MultiplePackagesEdited"
    | "Infrastructure";

export type PopularityLevel =
    | "Well-liked by everyone"
    | "Popular"
    | "Critical";

// Complete failure, won't be passed to `process` (no PR found)
export interface BotFail {
    readonly type: "fail";
    readonly message: string;
}

// Some error found, will be passed to `process` to report in a comment
export interface BotError {
    readonly type: "error";
    readonly pr_number: number;
    readonly message: string;
    readonly author: string | undefined;
}

export interface BotEnsureRemovedFromProject {
    readonly type: "remove";
    readonly pr_number: number;
    readonly message: string;
}

export interface BotNoPackages {
    readonly type: "no_packages";
    readonly pr_number: number;
}

export interface PrInfo {
    readonly type: "info";

    /** ISO8601 date string for the time the PR info was created at */
    readonly now: string;

    readonly pr_number: number;

    /**
     * The head commit of this PR (full format)
     */
    readonly headCommitOid: string;

    /**
     * The head commit of this PR (abbreviated format)
     */
    readonly headCommitAbbrOid: string;

    /**
     * True if the author of the PR is already a listed owner
     */
    readonly authorIsOwner: boolean;

    /**
     * The GitHub login of the PR author
     */
    readonly author: string;

    /**
     * The current list of owners of packages affected by this PR
     */
    readonly owners: readonly string[];

    /**
     * True if the author wants us to merge the PR
     */
    readonly mergeIsRequested: boolean;

    /**
     * The CI status of the head commit
     */
    readonly ciResult: CIResult;

    /**
     * A link to the log for the failing CI if it exists
     */
    readonly ciUrl: string | undefined;

    /**
     * True if the PR has a merge conflict
     */
    readonly hasMergeConflict: boolean;

    /**
     * The date the latest commit was pushed to GitHub
     */
    readonly lastPushDate: Date;

    /**
     * The date the anyone had a meaningful interaction with the PR
     */
    readonly lastCommentDate: Date;

    /**
     * The date of the most recent review on the head commit
     */
    readonly lastReviewDate?: Date;

    /**
     * The date the PR was last reopened by a maintainer
     */
    readonly reopenedDate?: Date;

    /**
     * A list of people who have reviewed this PR in the past, but for
     * a prior commit.
     */
    readonly reviewersWithStaleReviews: ReadonlyArray<{ reviewer: string, reviewedAbbrOid: string, date: string }>;

    /**
     * A link to the Review tab to provide reviewers with
     */
    readonly reviewLink: string;

    /**
     * True if the head commit has any failing reviews
     */
    readonly isChangesRequested: boolean;

    readonly approvalFlags: ApprovalFlags;
    readonly dangerLevel: DangerLevel;

    /**
     * Integer count of days of inactivity from the author
     */
    readonly stalenessInDays: number;

    readonly anyPackageIsNew: boolean;

    /**
     * True if a maintainer blessed this PR
     */
    readonly maintainerBlessed: boolean;

    /**
     * True if the author has dismissed any reviews against the head commit
     */
    readonly hasDismissedReview: boolean;

    readonly isFirstContribution: boolean;

    readonly popularityLevel: PopularityLevel;

    readonly packages: readonly string[];
    readonly files: readonly FileInfo[];
}

function getHeadCommit(pr: GraphqlPullRequest) {
    return pr.commits.nodes?.filter(c => c?.commit.oid === pr.headRefOid)?.[0]?.commit;
}

// Just the networking
export async function queryPRInfo(prNumber: number) {
    return await client.query<PRQueryResult>({
        query: GetPRInfo,
        variables: {
            pr_number: prNumber
        },
        fetchPolicy: "network-only",
        fetchResults: true
    });
}

// The GQL response => Useful data for us
export async function deriveStateForPR(
    info: ApolloQueryResult<PRQueryResult>,
    fetchFile = defaultFetchFile,
    getDownloads?: (packages: readonly string[]) => Record<string, number> | Promise<Record<string, number>>,
    getNow = () => new Date(),
): Promise<PrInfo | BotFail | BotError | BotEnsureRemovedFromProject | BotNoPackages>  {
    const prInfo = info.data.repository?.pullRequest;

    if (!prInfo) return botFail("No PR with this number exists");
    if (prInfo.author == null) return botError(prInfo.number, "PR author does not exist");

    const headCommit = getHeadCommit(prInfo);
    if (headCommit == null) return botError(prInfo.number, "No head commit found");

    if (prInfo.state !== "OPEN") return botEnsureRemovedFromProject(prInfo.number, "PR is not active");
    if (prInfo.isDraft) return botEnsureRemovedFromProject(prInfo.number, "PR is a draft");

    const categorizedFiles = await Promise.all(
        noNulls(prInfo.files?.nodes)
            .map(f => categorizeFile(f.path, async () => fetchFile(`${headCommit.oid}:${f.path}`))));
    const packages = getPackagesTouched(categorizedFiles);

    if (packages.length === 0) return botNoPackages(prInfo.number)

    const { error, anyPackageIsNew, allOwners } = await getOwnersOfPackages(packages, fetchFile);
    if (error) return botError(prInfo.number, error);

    const authorIsOwner = isOwner(prInfo.author.login);

    const isFirstContribution = prInfo.authorAssociation === CommentAuthorAssociation.FIRST_TIME_CONTRIBUTOR;

    const freshReviewsByState = partition(noNulls(prInfo.reviews?.nodes), r => r.state);
    const approvals = noNulls(freshReviewsByState.APPROVED);
    const hasDismissedReview = !!freshReviewsByState.DISMISSED?.length;
    const approvalsByRole = partition(approvals, review => { // UNUSED
        if (review?.author?.login === prInfo.author?.login) {
            return "self";
        }
        if (review?.authorAssociation === "OWNER" || review?.authorAssociation === "MEMBER") {
            // DefinitelyTyped maintainer
            return "maintainer";
        }
        if (allOwners.indexOf(review?.author?.login || "") >= 0) {
            // Known package owner
            return "owner";
        }
        return "other";
    });

    const lastPushDate = new Date(headCommit.pushedDate);
    const lastCommentDate = getLastCommentishActivityDate(prInfo.timelineItems, prInfo.reviews) || lastPushDate;
    const reopenedDate = getReopenedDate(prInfo.timelineItems);
    const now = getNow().toISOString();
    const reviewAnalysis = analyzeReviews(prInfo, isOwner);

    const lastBlessing = getLastMaintainerBlessingDate(prInfo.timelineItems);

    return {
        type: "info",
        now,
        pr_number: prInfo.number,
        author: prInfo.author.login,
        owners: allOwners,
        dangerLevel: getDangerLevel(categorizedFiles),
        headCommitAbbrOid: headCommit.abbreviatedOid,
        headCommitOid: headCommit.oid,
        mergeIsRequested: authorSaysReadyToMerge(prInfo),
        stalenessInDays: Math.min(...[lastPushDate, lastCommentDate, reopenedDate, reviewAnalysis.lastReviewDate]
                                     .map(date => daysSince(date || lastPushDate, now))),
        lastPushDate, reopenedDate, lastCommentDate,
        maintainerBlessed: lastBlessing ? lastBlessing.getTime() > lastPushDate.getTime() : false,
        reviewLink: `https://github.com/DefinitelyTyped/DefinitelyTyped/pull/${prInfo.number}/files`,
        hasMergeConflict: prInfo.mergeable === "CONFLICTING",
        authorIsOwner,
        isFirstContribution,
        popularityLevel: getDownloads
            ? getPopularityLevelFromDownloads(await getDownloads(packages))
            : await getPopularityLevel(packages),
        anyPackageIsNew,
        packages,
        files: categorizedFiles,
        hasDismissedReview,
        ...getCIResult(headCommit),
        ...reviewAnalysis
    };

    function botFail(message: string): BotFail {
        return { type: "fail", message };
    }

    function botError(pr_number: number, message: string): BotError {
        return { type: "error", message, pr_number, author: prInfo?.author?.login };
    }

    function botEnsureRemovedFromProject(pr_number: number, message: string): BotEnsureRemovedFromProject {
        return { type: "remove", pr_number, message };
    }

    function botNoPackages(pr_number: number): BotNoPackages {
        return { type: "no_packages", pr_number };
    }

    function isOwner(login: string) {
        return allOwners.some(k => k.toLowerCase() === login.toLowerCase());
    }
}

type ReopenedEvent = PR_repository_pullRequest_timelineItems_nodes_ReopenedEvent;
type ReadyForReviewEvent = PR_repository_pullRequest_timelineItems_nodes_ReadyForReviewEvent;

/** Either: when the PR was last opened, or switched to ready from draft */
function getReopenedDate(timelineItems: PR_repository_pullRequest_timelineItems) {
    const lastItem = findLast(timelineItems.nodes, (item): item is ReopenedEvent | ReadyForReviewEvent => (
        item?.__typename === "ReopenedEvent" || item?.__typename === "ReadyForReviewEvent"
      ));

    return lastItem && lastItem.createdAt && new Date(lastItem.createdAt)
}

type IssueComment = PR_repository_pullRequest_timelineItems_nodes_IssueComment;
function getLastCommentishActivityDate(timelineItems: PR_repository_pullRequest_timelineItems, reviews: PR_repository_pullRequest_reviews | null) {

    const lastIssueComment = findLast(timelineItems.nodes, (item): item is IssueComment => {
        return item?.__typename === "IssueComment" && authorNotBot(item!);
    });
    const lastReviewComment = forEachReverse(reviews?.nodes, review => {
        return findLast(review?.comments?.nodes, comment => !!comment?.author?.login)
    });

    if (lastIssueComment && lastReviewComment) {
        const latestDate = [lastIssueComment.createdAt, lastReviewComment.createdAt].sort()[1]
        return new Date(latestDate);
    }
    if (lastIssueComment || lastReviewComment) {
        return new Date((lastIssueComment || lastReviewComment)?.createdAt);
    }
    return undefined;
}

type MovedColumnsInProjectEvent = PR_repository_pullRequest_timelineItems_nodes_MovedColumnsInProjectEvent;
function getLastMaintainerBlessingDate(timelineItems: PR_repository_pullRequest_timelineItems) {
    const lastColumnChange = findLast(timelineItems.nodes, (item): item is MovedColumnsInProjectEvent => {
        return item?.__typename === "MovedColumnsInProjectEvent" && authorNotBot(item!);
    });
    // ------------------------------ TODO ------------------------------
    // Should add and used the `previousProjectColumnName` field to
    // verify that the move was away from "Needs Maintainer Review", but
    // that is still in beta ATM.
    // ------------------------------ TODO ------------------------------
    if (lastColumnChange) {
        return new Date(lastColumnChange.createdAt);
    }
    return undefined;
}

type FileKind = "test" | "definition" | "markdown" | "package-meta" | "package-meta-ok"| "infrastructure";

type FileInfo = {
    path: string,
    kind: FileKind,
    package: string | undefined
};

async function categorizeFile(path: string, contents: () => Promise<string | undefined>): Promise<FileInfo> {
    // https://regex101.com/r/eFvtrz/1
    const match = /^types\/(.*?)\/.*?[^\/](?:\.(d\.ts|tsx?|md))?$/.exec(path);
    if (!match) return { path, kind: "infrastructure", package: undefined };
    const [pkg, suffix] = match.slice(1); // `suffix` can be null
    switch ((suffix || "")) {
        case "d.ts": return { path, kind: "definition", package: pkg };
        case "ts": case "tsx": return { path, kind: "test", package: pkg };
        case "md": return { path, kind: "markdown", package: pkg };
        default:
            const ok = await configOK(path, contents);
            return { path, kind: ok ? "package-meta-ok" : "package-meta", package: pkg };
    }
}

interface ConfigOK {
    (path: string, getContents: () => Promise<string | undefined>): Promise<boolean>;
    [basename: string]: (text: string) => boolean;
};
const configOK = <ConfigOK>(async (path, getContents) => {
    const basename = path.replace(/.*\//, "");
    if (!(basename in configOK)) return false;
    const text = await getContents();
    if (text === undefined) return false;
    return configOK[basename](text)
});
configOK["OTHER_FILES.txt"] = contents => {
    // not empty, all path parts are not empty and not all dots
    return contents.length > 0 && contents.split(/\n/).every(line =>
        line === "" || line.split(/\//).every(part =>
            part.length > 0 && !part.match(/^\.+$/)));
};
configOK["tslint.json"] = contents => {
    // just the recommended form
    return JSON.stringify(JSON.parse(contents)) === JSON.stringify({ "extends": "dtslint/dt.json" });
};


export function getPackagesTouched(files: readonly FileInfo[]) {
    return [...new Set(noNulls(files.map(f => "package" in f ? f.package : null)))];
}

function partition<T, U extends string>(arr: ReadonlyArray<T>, sorter: (el: T) => U) {
    const res: { [K in U]?: T[] } = {};
    for (const el of arr) {
        const key = sorter(el);
        const target: T[] = res[key] ?? (res[key] = []);
        target.push(el);
    }
    return res;
}

function authorSaysReadyToMerge(info: PR_repository_pullRequest) {
    return info.comments.nodes?.some(comment => {
        if (comment?.author?.login === info.author?.login) {
            if (comment?.body.trim().toLowerCase().startsWith("ready to merge")) {
                return true;
            }
        }
        return false;
    }) ?? false;
}

function analyzeReviews(prInfo: PR_repository_pullRequest, isOwner: (name: string) => boolean) {
    const hasUpToDateReview: Set<string> = new Set();
    const headCommitOid: string = prInfo.headRefOid;
    /** Key: commit id. Value: review info. */
    const staleReviewAuthorsByCommit = new Map<string, { reviewer: string, date: string }>();
    let lastReviewDate;
    let isChangesRequested = false;
    let approvalFlags = ApprovalFlags.None;

    // Do this in reverse order so we can detect up-to-date-reviews correctly
    const reviews = [...prInfo.reviews?.nodes ?? []].reverse();

    for (const r of reviews) {
        // Skip nulls
        if (!r?.commit || !r?.author?.login) continue;
        // Skip self-reviews
        if (r.author.login === prInfo.author!.login) continue;

        if (r.commit.oid !== headCommitOid) {
            // Stale review
            // Reviewers with reviews of the current commit are not stale
            if (!hasUpToDateReview.has(r.author.login)) {
                staleReviewAuthorsByCommit.set(r.commit.abbreviatedOid, { reviewer: r.author.login, date: r.submittedAt });
            }
        } else if (!hasUpToDateReview.has(r.author.login)) {
            // Most recent review of head commit for this author
            hasUpToDateReview.add(r.author.login);
            const reviewDate = new Date(r.submittedAt);
            lastReviewDate = lastReviewDate && lastReviewDate > reviewDate ? lastReviewDate : reviewDate;
            if (r.state === PullRequestReviewState.CHANGES_REQUESTED) {
                isChangesRequested = true;
            } else if (r.state === PullRequestReviewState.APPROVED) {
                if ((r.authorAssociation === CommentAuthorAssociation.MEMBER) || (r.authorAssociation === CommentAuthorAssociation.OWNER)) {
                    approvalFlags |= ApprovalFlags.Maintainer;
                } else if (isOwner(r.author.login)) {
                    approvalFlags |= ApprovalFlags.Owner;
                } else {
                    approvalFlags |= ApprovalFlags.Other;
                }
            }
        }
    }

    return ({
        lastReviewDate,
        reviewersWithStaleReviews: Array.from(staleReviewAuthorsByCommit.entries()).map(([commit, info]) => ({
            reviewedAbbrOid: commit,
            reviewer: info.reviewer,
            date: info.date
        })),
        approvalFlags,
        isChangesRequested
    });
}

function getDangerLevel(categorizedFiles: readonly FileInfo[]) {
    if (categorizedFiles.some(f => f.kind === "infrastructure")) {
        return "Infrastructure";
    }
    const packagesTouched = getPackagesTouched(categorizedFiles);
    if (packagesTouched.length === 0) {
        return "Infrastructure";
    } else if (packagesTouched.length > 1) {
        return "MultiplePackagesEdited";
    } else if (categorizedFiles.some(f => f.kind === "package-meta")) {
        return "ScopedAndConfiguration";
    } else if (categorizedFiles.some(f => f.kind === "test")) {
        return "ScopedAndTested";
    } else {
        return "ScopedAndUntested";
    }
}

function getCIResult(headCommit: PR_repository_pullRequest_commits_nodes_commit) {
    let ciUrl: string | undefined = undefined;
    let ciResult: CIResult = undefined!;

    const totalStatusChecks = headCommit.checkSuites?.nodes?.find(check => check?.app?.name?.includes("GitHub Actions"))
    if (totalStatusChecks) {
        switch (totalStatusChecks.conclusion) {
            case CheckConclusionState.SUCCESS:
                ciResult = CIResult.Pass;
                break;

            case CheckConclusionState.FAILURE:
            case CheckConclusionState.SKIPPED:
            case CheckConclusionState.TIMED_OUT:
                ciResult = CIResult.Fail;
                ciUrl = totalStatusChecks.url;
                break;

            default:
                ciResult = CIResult.Pending;
                break;
        }
    }

    if (!ciResult) {
        return { ciResult: CIResult.Missing, ciUrl: undefined };
    }

    return { ciResult, ciUrl };
}

async function getPopularityLevel(packagesTouched: string[]): Promise<PopularityLevel> {
    let popularityLevel: PopularityLevel = "Well-liked by everyone";
    for (const p of packagesTouched) {
        const downloads = await getMonthlyDownloadCount(p);
        if (downloads > CriticalPopularityThreshold) {
            // Can short-circuit
            return "Critical";
        } else if (downloads > NormalPopularityThreshold) {
            popularityLevel = "Popular";
        }
    }
    return popularityLevel;
}

function getPopularityLevelFromDownloads(downloadsPerPackage: Record<string, number>) {
    let popularityLevel: PopularityLevel = "Well-liked by everyone";
    for (const packageName in downloadsPerPackage) {
        const downloads = downloadsPerPackage[packageName];
        if (downloads > CriticalPopularityThreshold) {
            // Can short-circuit
            return "Critical";
        } else if (downloads > NormalPopularityThreshold) {
            popularityLevel = "Popular";
        }
    }
    return popularityLevel;
}

interface OwnerInfo {
    anyPackageIsNew: boolean;
    allOwners: string[];
    error: string | undefined;
}

async function getOwnersOfPackages(packages: readonly string[], fetchFile: typeof defaultFetchFile): Promise<OwnerInfo> {
    const allOwners: Set<string> = new Set();
    let anyPackageIsNew = false, error = undefined;
    for (const p of packages) {
        let owners;
        try {
            owners = await getOwnersForPackage(p, fetchFile);
        } catch (e) {
            error = `error parsing owners: ${e.message}`;
            break;
        }
        if (owners === undefined) {
            anyPackageIsNew = true;
        } else {
            owners.forEach(o => allOwners.add(o));
        }
    }
    return { error, allOwners: [...allOwners], anyPackageIsNew };
}

async function getOwnersForPackage(packageName: string, fetchFile: typeof defaultFetchFile): Promise<string[] | undefined> {
    const indexDts = `master:types/${packageName}/index.d.ts`;
    const indexDtsContent = await fetchFile(indexDts, 10240); // grab at most 10k
    if (indexDtsContent === undefined) return undefined;
    const parsed = HeaderParser.parseHeaderOrFail(indexDtsContent);
    return parsed.contributors.map(c => c.githubUsername).filter(notUndefined);
}

function noNulls<T>(arr: ReadonlyArray<T | null | undefined> | null | undefined): T[] {
    if (arr == null) return [];
    return arr.filter(arr => arr != null) as T[];
}
function notUndefined<T>(arg: T | undefined): arg is T { return arg !== undefined; }
