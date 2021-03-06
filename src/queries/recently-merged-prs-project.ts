import { gql } from "apollo-boost";
import { client } from "../graphql-client";
import { GetRecentlyMergedPRsProject } from "./schema/GetRecentlyMergedPRsProject";

const GetRecentlyMergedPRsProjectQuery = gql`
  query GetRecentlyMergedPRsProject {
    repository(owner: "DefinitelyTyped", name: "DefinitelyTyped") {
      id
      project(number: 5) {
        id
        columns(first: 100) {
          nodes {
            id
            name
            cards(last: 100) {
              nodes {
                id
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

export async function getRecentlyUpdatedPRProjectBoardCards() {
  const results = await client.query<GetRecentlyMergedPRsProject>({
    query: GetRecentlyMergedPRsProjectQuery,
    fetchPolicy: "network-only",
    fetchResults: true
  });

  if (results.errors) {
    throw new Error(JSON.stringify(results.errors));
  }

  const project = results.data.repository?.project;

  if (!project) {
    throw new Error("No project found");
  }

  const recentlyMergedColumn = project.columns.nodes?.find(c => c?.name === "Recently Merged");
  if (!recentlyMergedColumn) {
    throw new Error(`Could not find the 'Recently Merged' column in ${project.columns.nodes?.map((n) => n?.name)}`);
  }

  return recentlyMergedColumn.cards.nodes as { id: string; updatedAt: string }[];
}
