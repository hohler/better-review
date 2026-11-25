// GitHub through the gh CLI. Every answer is reshaped into the form twg gives for Bitbucket, so the UI knows one shape.
use crate::run;
use serde_json::{json, Value};

pub const HOST: &str = "github.com";

// A GitHub repo is named "github.com/owner/name" in the app, a Bitbucket one "workspace/name".
pub fn repo(repo: &str) -> Option<&str> {
    repo.strip_prefix("github.com/")
}

// ponytail: first 100 of every list, no paging. Page with cursors if a PR or inbox outgrows that.
const INBOX: &str = "query { viewer { login } requested: search(query: \"is:pr is:open archived:false review-requested:@me\", type: ISSUE, first: 100) { nodes { ...item } } reviewed: search(query: \"is:pr is:open archived:false reviewed-by:@me -author:@me\", type: ISSUE, first: 100) { nodes { ...item } } } fragment item on PullRequest { number title updatedAt isDraft url author { login } repository { nameWithOwner } viewerLatestReview { state } }";
const PR: &str = "query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { id title body state updatedAt url headRefName baseRefName headRefOid author { login } reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } } latestReviews(first: 100) { nodes { state author { login } } } reviews(first: 100) { nodes { databaseId state body createdAt author { login } } } comments(first: 100) { nodes { databaseId body createdAt author { login } } } reviewThreads(first: 100) { nodes { isResolved path line originalLine diffSide comments(first: 100) { nodes { databaseId body createdAt state author { login } } } } } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl completedAt startedAt } ... on StatusContext { context state targetUrl createdAt } } } } } } } } } }";
const MY_REVIEWS: &str = "query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(last: 100) { nodes { databaseId state author { login } } } } } }";
const ADD_THREAD: &str = "mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }";

// The request body goes through stdin as JSON, so no text from the webview is ever parsed as a flag.
fn api(method: &str, path: &str, body: Value) -> Result<Value, String> {
    let mut args = vec!["api", "--hostname", HOST, "-X", method, path];
    if !body.is_null() {
        args.extend(["--input", "-"]);
    }
    let out = run("gh", &args, (!body.is_null()).then(|| body.to_string())).map_err(explain)?;
    Ok(serde_json::from_str(&out).unwrap_or(Value::Null))
}

fn graphql(query: &str, variables: Value) -> Result<Value, String> {
    let v = api("POST", "graphql", json!({ "query": query, "variables": variables }))?;
    v.get("data").cloned().ok_or_else(|| "gh returned no data".to_string())
}

// GitHub's own wording for the one case a reviewer runs into often.
fn explain(e: String) -> String {
    if e.contains("pending review") {
        "You have a pending review on this pull request. Use \"Add to review\", or finish the review first.".into()
    } else {
        e
    }
}

fn split(repo: &str) -> Result<(&str, &str), String> {
    repo.split_once('/').filter(|(o, n)| !o.is_empty() && !n.is_empty() && !n.contains('/')).ok_or_else(|| format!("Invalid repository: {repo}"))
}

fn pr_vars(repo: &str, id: u64) -> Result<Value, String> {
    let (owner, name) = split(repo)?;
    Ok(json!({ "owner": owner, "name": name, "number": id }))
}

// Comment ids carry their kind: i = comment on the PR, r = comment on a line, v = text of a review.
fn num(id: &str, kind: char) -> Option<u64> {
    id.strip_prefix(kind)?.parse().ok()
}

fn user(v: &Value) -> Value {
    let login = v["login"].as_str().unwrap_or("ghost");
    json!({ "uuid": login, "display_name": login })
}

pub fn inbox() -> Result<String, String> {
    Ok(shape_inbox(&graphql(INBOX, json!({}))?).to_string())
}

fn shape_inbox(data: &Value) -> Value {
    let mut items: Vec<Value> = Vec::new();
    for (list, requested) in [("requested", true), ("reviewed", false)] {
        for n in data[list]["nodes"].as_array().into_iter().flatten() {
            let repo = format!("{HOST}/{}", n["repository"]["nameWithOwner"].as_str().unwrap_or(""));
            if n["number"].is_null() || items.iter().any(|i| i["repo"] == repo.as_str() && i["id"] == n["number"]) {
                continue;
            }
            // A new review request after my approval counts as open again.
            let state = if requested { "" } else { n["viewerLatestReview"]["state"].as_str().unwrap_or("") };
            items.push(json!({
                "id": n["number"], "title": n["title"], "repo": repo, "updatedOn": n["updatedAt"], "draft": n["isDraft"], "link": n["url"],
                "author": { "displayName": n["author"]["login"] },
                "attention": { "approved": state == "APPROVED", "participantState": if state == "CHANGES_REQUESTED" { json!("changes_requested") } else { Value::Null } },
            }));
        }
    }
    json!({ "workspace": HOST, "currentUser": { "uuid": data["viewer"]["login"], "displayName": data["viewer"]["login"] }, "items": items })
}

pub fn pr(repo: &str, id: u64) -> Result<String, String> {
    let data = graphql(PR, pr_vars(repo, id)?)?;
    if data["repository"]["pullRequest"].is_null() {
        return Err(format!("Pull request {repo}#{id} was not found on GitHub"));
    }
    Ok(shape_pr(&data).to_string())
}

fn shape_pr(data: &Value) -> Value {
    let p = &data["repository"]["pullRequest"];
    let nodes = |v: &Value| v["nodes"].as_array().cloned().unwrap_or_default();

    // Reviewers: everyone with a verdict, then everyone still asked. A new request replaces an old verdict.
    let mut people: Vec<Value> = Vec::new();
    for r in nodes(&p["latestReviews"]) {
        let state = match r["state"].as_str() {
            Some("APPROVED") => json!("approved"),
            Some("CHANGES_REQUESTED") => json!("changes_requested"),
            _ => Value::Null,
        };
        people.push(json!({ "user": user(&r["author"]), "role": "REVIEWER", "approved": state == "approved", "state": state }));
    }
    for r in nodes(&p["reviewRequests"]) {
        let who = &r["requestedReviewer"];
        let u = if who["login"].is_string() { user(who) } else { json!({ "uuid": format!("team:{}", who["name"].as_str().unwrap_or("?")), "display_name": who["name"].as_str().unwrap_or("Team") }) };
        people.retain(|x| x["user"]["uuid"] != u["uuid"]);
        people.push(json!({ "user": u, "role": "REVIEWER", "approved": false, "state": null }));
    }

    let mut comments: Vec<Value> = Vec::new();
    for c in nodes(&p["comments"]) {
        comments.push(json!({ "id": format!("i{}", c["databaseId"]), "user": user(&c["author"]), "content": { "raw": c["body"] }, "created_on": c["createdAt"] }));
    }
    // The text of a review is part of the discussion. GitHub cannot delete it, so the app does not offer to.
    for r in nodes(&p["reviews"]) {
        if r["state"] != "PENDING" && !r["body"].as_str().unwrap_or("").trim().is_empty() {
            comments.push(json!({ "id": format!("v{}", r["databaseId"]), "user": user(&r["author"]), "content": { "raw": r["body"] }, "created_on": r["createdAt"], "readonly": true }));
        }
    }
    for t in nodes(&p["reviewThreads"]) {
        // line is null once the code under the comment changed: the UI then lists the thread as outside the diff.
        let inline = if t["diffSide"] == "LEFT" { json!({ "path": t["path"], "from": t["line"], "to": null }) } else { json!({ "path": t["path"], "to": t["line"], "from": null }) };
        let mut root = Value::Null;
        for c in nodes(&t["comments"]) {
            let id = json!(format!("r{}", c["databaseId"]));
            let mut out = json!({ "id": id, "user": user(&c["author"]), "content": { "raw": c["body"] }, "created_on": c["createdAt"], "inline": inline, "pending": c["state"] == "PENDING" });
            if root.is_null() {
                out["resolution"] = if t["isResolved"] == true { json!({}) } else { Value::Null };
                root = id;
            } else {
                out["parent"] = json!({ "id": root });
            }
            comments.push(out);
        }
    }
    // The UI expects replies after the comment they answer.
    comments.sort_by(|a, b| a["created_on"].as_str().cmp(&b["created_on"].as_str()));

    let checks = nodes(&p["commits"]).first().map(|c| nodes(&c["commit"]["statusCheckRollup"]["contexts"])).unwrap_or_default();
    let statuses: Vec<Value> = checks
        .iter()
        .map(|c| {
            if c["__typename"] == "CheckRun" {
                let state = match (c["status"].as_str(), c["conclusion"].as_str()) {
                    (Some("COMPLETED"), Some("SUCCESS" | "NEUTRAL" | "SKIPPED")) => "SUCCESSFUL",
                    (Some("COMPLETED"), Some("CANCELLED")) => "STOPPED",
                    (Some("COMPLETED"), _) => "FAILED",
                    _ => "INPROGRESS",
                };
                json!({ "state": state, "name": c["name"], "url": c["detailsUrl"], "updated_on": if c["completedAt"].is_null() { &c["startedAt"] } else { &c["completedAt"] } })
            } else {
                let state = match c["state"].as_str() {
                    Some("SUCCESS") => "SUCCESSFUL",
                    Some("PENDING" | "EXPECTED") => "INPROGRESS",
                    _ => "FAILED",
                };
                json!({ "state": state, "name": c["context"], "url": c["targetUrl"], "updated_on": c["createdAt"] })
            }
        })
        .collect();

    json!({
        "title": p["title"], "description": p["body"], "state": p["state"], "updated_on": p["updatedAt"],
        "author": user(&p["author"]),
        "source": { "branch": { "name": p["headRefName"] }, "commit": { "hash": p["headRefOid"] } },
        "destination": { "branch": { "name": p["baseRefName"] } },
        "links": { "html": { "href": p["url"] } },
        "participants": people, "_comments": comments, "_statuses": statuses,
    })
}

pub fn diff(repo: &str, id: u64) -> Result<String, String> {
    // ponytail: GitHub refuses a diff of more than 300 files or 20000 lines. Read the files API page by page if that bites.
    run("gh", &["pr", "diff", &id.to_string(), "--repo", &format!("{HOST}/{repo}")], None)
}

pub fn file(repo: &str, path: &str, hash: &str) -> Result<String, String> {
    let keep = |b: u8| b.is_ascii_alphanumeric() || b"-._~/".contains(&b);
    let path: String = path.bytes().map(|b| if keep(b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    run("gh", &["api", "--hostname", HOST, "-H", "Accept: application/vnd.github.raw+json", &format!("repos/{repo}/contents/{path}?ref={hash}")], None)
}

pub fn comment(repo: &str, id: u64, text: &str, path: Option<&str>, line: Option<u32>, from_line: Option<u32>, reply_to: Option<&str>, pending: bool) -> Result<String, String> {
    if let Some(parent) = reply_to {
        let parent = num(parent, 'r').ok_or("GitHub only takes replies to comments on a line")?;
        if pending {
            return Err("On GitHub a reply is posted right away".into());
        }
        return api("POST", &format!("repos/{repo}/pulls/{id}/comments/{parent}/replies"), json!({ "body": text })).map(|_| String::new());
    }
    let Some(path) = path else {
        if pending {
            return Err("GitHub keeps only comments on a line pending".into());
        }
        return api("POST", &format!("repos/{repo}/issues/{id}/comments"), json!({ "body": text })).map(|_| String::new());
    };
    // A removed line is on the left side of the diff, every other line on the right.
    let (line, side) = match (line, from_line) {
        (Some(l), _) => (l, "RIGHT"),
        (None, Some(l)) => (l, "LEFT"),
        _ => return Err("A comment on a file needs a line".into()),
    };
    let head = api("GET", &format!("repos/{repo}/pulls/{id}"), Value::Null)?;
    if pending {
        // Joins my pending review and starts one if there is none.
        graphql(ADD_THREAD, json!({ "input": { "pullRequestId": head["node_id"], "path": path, "line": line, "side": side, "body": text } }))?;
    } else {
        api("POST", &format!("repos/{repo}/pulls/{id}/comments"), json!({ "body": text, "commit_id": head["head"]["sha"], "path": path, "line": line, "side": side }))?;
    }
    Ok(String::new())
}

fn comment_path(repo: &str, comment: &str) -> Result<String, String> {
    if let Some(n) = num(comment, 'i') {
        Ok(format!("repos/{repo}/issues/comments/{n}"))
    } else if let Some(n) = num(comment, 'r') {
        Ok(format!("repos/{repo}/pulls/comments/{n}"))
    } else {
        Err("This comment cannot be changed from here".into())
    }
}

pub fn comment_update(repo: &str, comment: &str, text: &str) -> Result<String, String> {
    api("PATCH", &comment_path(repo, comment)?, json!({ "body": text })).map(|_| String::new())
}

pub fn comment_delete(repo: &str, comment: &str) -> Result<String, String> {
    api("DELETE", &comment_path(repo, comment)?, Value::Null).map(|_| String::new())
}

// GitHub has no "unapprove": taking a verdict back means dismissing that review.
pub fn review(repo: &str, id: u64, action: &str, text: Option<&str>) -> Result<String, String> {
    let data = graphql(MY_REVIEWS, pr_vars(repo, id)?)?;
    let me = data["viewer"]["login"].clone();
    let mine: Vec<&Value> = data["repository"]["pullRequest"]["reviews"]["nodes"].as_array().into_iter().flatten().filter(|r| r["author"]["login"] == me).collect();
    let last = |state: &str| mine.iter().rev().find(|r| r["state"] == state).and_then(|r| r["databaseId"].as_u64());
    let base = format!("repos/{repo}/pulls/{id}/reviews");
    match action {
        "approve" | "request-changes" => {
            let event = if action == "approve" { "APPROVE" } else { "REQUEST_CHANGES" };
            let mut body = json!({ "event": event });
            if let Some(t) = text.filter(|t| !t.trim().is_empty()) {
                body["body"] = json!(t);
            } else if action == "request-changes" && last("PENDING").is_none() {
                return Err("GitHub needs a comment that says what has to change".into());
            }
            // A pending review is submitted with the verdict, which also publishes its comments.
            match last("PENDING") {
                Some(pending) => api("POST", &format!("{base}/{pending}/events"), body),
                None => api("POST", &base, body),
            }
        }
        "unapprove" | "remove-request-changes" => {
            let state = if action == "unapprove" { "APPROVED" } else { "CHANGES_REQUESTED" };
            let review = last(state).ok_or("No review of yours to take back")?;
            api("PUT", &format!("{base}/{review}/dismissals"), json!({ "message": "Withdrawn by the reviewer", "event": "DISMISS" }))
        }
        _ => Err(format!("Unknown action: {action}")),
    }
    .map(|_| String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_merges_both_searches() {
        let item = |n: u64, state: Value| json!({ "number": n, "title": "T", "updatedAt": "2026-01-01T00:00:00Z", "isDraft": false, "url": "u", "author": { "login": "ann" }, "repository": { "nameWithOwner": "acme/shop" }, "viewerLatestReview": state });
        let data = json!({ "viewer": { "login": "me" }, "requested": { "nodes": [item(1, json!({ "state": "APPROVED" })), {}] }, "reviewed": { "nodes": [item(1, json!({ "state": "APPROVED" })), item(2, json!({ "state": "APPROVED" })), item(3, json!({ "state": "CHANGES_REQUESTED" }))] } });
        let out = shape_inbox(&data);
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["repo"], "github.com/acme/shop");
        assert_eq!(items[0]["attention"]["approved"], false); // asked again after approving
        assert_eq!(items[1]["attention"]["approved"], true);
        assert_eq!(items[2]["attention"]["participantState"], "changes_requested");
        assert_eq!(out["currentUser"]["uuid"], "me");
    }

    #[test]
    fn pr_takes_the_bitbucket_shape() {
        let c = |id: u64, at: &str, state: &str| json!({ "databaseId": id, "body": format!("c{id}"), "createdAt": at, "state": state, "author": { "login": "ann" } });
        let data = json!({ "repository": { "pullRequest": {
            "title": "T", "body": "B", "state": "OPEN", "updatedAt": "2026-01-03", "url": "https://github.com/acme/shop/pull/7", "headRefName": "feat", "baseRefName": "main", "headRefOid": "abc", "author": { "login": "ann" },
            "reviewRequests": { "nodes": [{ "requestedReviewer": { "login": "bob" } }, { "requestedReviewer": { "name": "core" } }] },
            "latestReviews": { "nodes": [{ "state": "APPROVED", "author": { "login": "bob" } }, { "state": "CHANGES_REQUESTED", "author": { "login": "cy" } }] },
            "reviews": { "nodes": [{ "databaseId": 5, "state": "CHANGES_REQUESTED", "body": "Please fix", "createdAt": "2026-01-02T03", "author": { "login": "cy" } }, { "databaseId": 6, "state": "PENDING", "body": "draft", "createdAt": "2026-01-02T04", "author": { "login": "me" } }] },
            "comments": { "nodes": [{ "databaseId": 9, "body": "hi", "createdAt": "2026-01-02T05", "author": null }] },
            "reviewThreads": { "nodes": [
                { "isResolved": true, "path": "a.ts", "line": 12, "originalLine": 12, "diffSide": "RIGHT", "comments": { "nodes": [c(1, "2026-01-02T01", "SUBMITTED"), c(2, "2026-01-02T06", "PENDING")] } },
                { "isResolved": false, "path": "a.ts", "line": 4, "originalLine": 4, "diffSide": "LEFT", "comments": { "nodes": [c(3, "2026-01-02T02", "SUBMITTED")] } },
            ] },
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://ci/1", "completedAt": "t1", "startedAt": "t0" },
                { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": null, "completedAt": null, "startedAt": "t0" },
                { "__typename": "StatusContext", "context": "deploy", "state": "SUCCESS", "targetUrl": "https://d", "createdAt": "t2" },
            ] } } } }] },
        } } });
        let pr = shape_pr(&data);
        assert_eq!(pr["source"]["commit"]["hash"], "abc");
        assert_eq!(pr["links"]["html"]["href"], "https://github.com/acme/shop/pull/7");
        // bob approved but is asked again, cy wants changes, the team is waiting.
        let who: Vec<(String, String)> = pr["participants"].as_array().unwrap().iter().map(|p| (p["user"]["uuid"].as_str().unwrap().to_string(), p["state"].as_str().unwrap_or("-").to_string())).collect();
        assert_eq!(who, [("cy".into(), "changes_requested".into()), ("bob".into(), "-".into()), ("team:core".into(), "-".into())]);
        let ids: Vec<&str> = pr["_comments"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["r1", "r3", "v5", "i9", "r2"]);
        let by = |id: &str| pr["_comments"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone();
        assert_eq!(by("r1")["inline"]["to"], 12);
        assert!(by("r1")["resolution"].is_object());
        assert_eq!(by("r2")["parent"]["id"], "r1");
        assert_eq!(by("r2")["pending"], true);
        assert_eq!(by("r3")["inline"]["from"], 4);
        assert!(by("r3")["inline"]["to"].is_null());
        assert_eq!(by("v5")["readonly"], true);
        assert_eq!(by("i9")["user"]["uuid"], "ghost");
        let states: Vec<&str> = pr["_statuses"].as_array().unwrap().iter().map(|s| s["state"].as_str().unwrap()).collect();
        assert_eq!(states, ["FAILED", "INPROGRESS", "SUCCESSFUL"]);
        assert_eq!(pr["_statuses"][1]["updated_on"], "t0");
    }

    // Reads from the real GitHub, writes nothing: BR_REPO=owner/name BR_PR=12 cargo test -- --ignored live --nocapture
    #[test]
    #[ignore]
    fn live_read() {
        let (repo, id) = (std::env::var("BR_REPO").unwrap(), std::env::var("BR_PR").unwrap().parse().unwrap());
        let inbox: Value = serde_json::from_str(&inbox().unwrap()).unwrap();
        println!("inbox: {} items", inbox["items"].as_array().unwrap().len());
        let pr: Value = serde_json::from_str(&pr(&repo, id).unwrap()).unwrap();
        println!("pr: {} comments, {} builds, {} reviewers", pr["_comments"].as_array().unwrap().len(), pr["_statuses"].as_array().unwrap().len(), pr["participants"].as_array().unwrap().len());
        let diff = diff(&repo, id).unwrap();
        let path = diff.lines().find_map(|l| l.strip_prefix("+++ b/")).unwrap();
        println!("diff: {} lines, first file {path}: {} bytes", diff.lines().count(), file(&repo, path, pr["source"]["commit"]["hash"].as_str().unwrap()).unwrap().len());
    }

    #[test]
    fn ids_and_repos_are_checked() {
        assert_eq!(repo("github.com/acme/shop"), Some("acme/shop"));
        assert_eq!(repo("acme/shop"), None);
        assert_eq!(num("r12", 'r'), Some(12));
        assert_eq!(num("r12", 'i'), None);
        assert!(split("acme").is_err());
        assert!(comment_path("acme/shop", "v5").is_err());
        assert_eq!(comment_path("acme/shop", "i7").unwrap(), "repos/acme/shop/issues/comments/7");
    }
}
