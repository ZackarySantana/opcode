---
"@lidtop/opencode-gh-pr-status": patch
---

Stop listing a review request as waiting on you once you've reviewed since it was made. A team request that GitHub keeps after your review (such as one a ruleset requires), or a request GitHub's search still lists after you approved, no longer appears in the sidebar; a request made again after your review still does. Your latest review is now read with `viewerLatestReview`, since `latestReviews` can leave it out.
