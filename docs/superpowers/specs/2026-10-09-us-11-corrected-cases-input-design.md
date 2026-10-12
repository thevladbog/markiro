# US-11 corrected Cases input foundation

This bounded increment connects the saved corrected Transformation evidence to
the next Cases stage. It does not create boxes, links, receipts or HTTP routes.
Regular-chain codecs and the immutable six-month recipe remain unchanged.

The new strict, descriptor-safe codec is `us-dataset-corrected-cases-input-v1`.
It carries the existing version and definition digest, validated reference and
amendment identities, Receiving origin, completed Transformation journal identity
(revision 2), native Transformation origin (revision 1, lifecycle version 2),
output lot/product IDs and captured support. Do not fabricate a regular-chain
index or a regular Receiving identity to reuse its parser.

Support contains exactly the recipe's 60 SSCCs (serials 15641–15700) in order.
The seed-owned shift uses number sequence 261, following regular slots 1–260.
Its number month is the UTC month of captured technical time, not a backdated
business date. Shift and box UUIDs are canonical, unique and disjoint from known
prerequisite record identities. Device box identifiers remain trimmed nonblank
unique text. Reject normalization, aliases, extra fields and malformed JSON;
return a deeply frozen owned copy without freezing caller objects.

Standalone disjointness covers carried dataset, Receiving root/revision/input lots,
Transformation root/revision, output lot and product IDs. The factory additionally
checks receipt-owned Transformation document IDs. Other uncaptured master-data
identities and actual database collisions belong to the future executor.

The factory accepts reference identity, saved amendment stage, saved Transformation
stage and support. First guard combined raw evidence. Delegate upstream validation
to the accepted corrected Transformation factory/result parser. Bind stage intent,
receipt, operation key, digests and exact owned record IDs to the same prerequisite.
Only a coherent pending revision-1/null-receipt stage is prerequisite-incomplete;
contradictory or mismatched evidence is dependency-conflict. Standalone parsing
uses input-invalid. Errors expose fixed correction unit/Cases stage context, not
caller values. These checks establish stored coherence, not current database
ownership, authorization or locking; the future executor must prove those again.

Tests cover recipe cardinality/identity, immutable copies, hostile descriptors,
origin aliases, numbering/month, prerequisite mismatches and pending stages.
A native test obtains actual completed corrected Transformation journal evidence
from the existing executor in a disposable fixture database. No fake native stage
or receipt, base-database mutation, widened legacy contract or release is allowed.

Next increments implement native corrected Cases support/link execution and
current-state verification, followed by Shipping 50 of the 60 cases.
