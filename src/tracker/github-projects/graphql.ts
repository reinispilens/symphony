export const PROJECT_ITEMS_QUERY = String.raw`
  query SymphonyProjectItems(
    $owner: String!
    $repo: String!
    $projectNumber: Int!
    $cursor: String
    $statusField: String!
    $priorityField: String!
  ) {
    repository(owner: $owner, name: $repo) {
      owner {
        __typename
        ... on Organization {
          projectV2(number: $projectNumber) { ...SymphonyProjectPage }
        }
        ... on User {
          projectV2(number: $projectNumber) { ...SymphonyProjectPage }
        }
      }
    }
  }

  fragment SymphonyProjectPage on ProjectV2 {
    id
    number
    items(first: 100, after: $cursor) {
      nodes {
        ...SymphonyProjectItem
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }

  fragment SymphonyProjectItem on ProjectV2Item {
    __typename
    id
    isArchived
    project {
      id
      number
      owner {
        __typename
        ... on Organization { login }
        ... on User { login }
      }
    }
    statusValue: fieldValueByName(name: $statusField) {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { id name updatedAt }
    }
    priorityValue: fieldValueByName(name: $priorityField) {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { name }
    }
    content {
      __typename
      ... on Issue {
        id
        number
        title
        body
        url
        state
        createdAt
        updatedAt
        repository {
          name
          nameWithOwner
          owner { login }
        }
        labels(first: 100) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
        assignees(first: 1) { nodes { id } }
      }
    }
  }
`;

export const PROJECT_ITEMS_BY_ID_QUERY = String.raw`
  query SymphonyProjectItemsById(
    $ids: [ID!]!
    $statusField: String!
    $priorityField: String!
  ) {
    nodes(ids: $ids) {
      ...SymphonyProjectItemById
    }
  }

  fragment SymphonyProjectItemById on ProjectV2Item {
    __typename
    id
    isArchived
    project {
      id
      number
      owner {
        __typename
        ... on Organization { login }
        ... on User { login }
      }
    }
    statusValue: fieldValueByName(name: $statusField) {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { id name updatedAt }
    }
    priorityValue: fieldValueByName(name: $priorityField) {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { name }
    }
    content {
      __typename
      ... on Issue {
        id
        number
        title
        body
        url
        state
        createdAt
        updatedAt
        repository {
          name
          nameWithOwner
          owner { login }
        }
        labels(first: 100) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
        assignees(first: 1) { nodes { id } }
      }
    }
  }
`;

export const ISSUE_LABELS_QUERY = String.raw`
  query SymphonyIssueLabels($id: ID!, $cursor: String) {
    node(id: $id) {
      __typename
      ... on Issue {
        labels(first: 100, after: $cursor) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const ISSUE_WORKPAD_COMMENTS_QUERY = String.raw`
  query SymphonyIssueWorkpadComments($id: ID!, $cursor: String) {
    node(id: $id) {
      __typename
      ... on Issue {
        comments(first: 100, after: $cursor) {
          nodes { id body url createdAt author { login } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const CREATE_ISSUE_WORKPAD_MUTATION = String.raw`
  mutation SymphonyCreateIssueWorkpad($issueId: ID!, $body: String!) {
    addComment(input: { subjectId: $issueId, body: $body }) {
      commentEdge { node { id body url } }
    }
  }
`;

export const UPDATE_ISSUE_WORKPAD_MUTATION = String.raw`
  mutation SymphonyUpdateIssueWorkpad($commentId: ID!, $body: String!) {
    updateIssueComment(input: { id: $commentId, body: $body }) {
      issueComment { id body url }
    }
  }
`;

export const DELETE_ISSUE_WORKPAD_MUTATION = String.raw`
  mutation SymphonyDeleteIssueWorkpad($commentId: ID!) {
    deleteIssueComment(input: { id: $commentId }) { clientMutationId }
  }
`;

export const PULL_REQUEST_QUERY = String.raw`
  query SymphonyPullRequest($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { id number state url }
    }
  }
`;

export const CLOSE_PULL_REQUEST_MUTATION = String.raw`
  mutation SymphonyClosePullRequest($pullRequestId: ID!) {
    closePullRequest(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id number state url }
    }
  }
`;

export const PROJECT_STATUS_FIELD_QUERY = String.raw`
  query SymphonyProjectStatusField(
    $owner: String!
    $repo: String!
    $projectNumber: Int!
    $statusField: String!
  ) {
    repository(owner: $owner, name: $repo) {
      owner {
        __typename
        ... on Organization {
          projectV2(number: $projectNumber) { ...SymphonyProjectStatusField }
        }
        ... on User {
          projectV2(number: $projectNumber) { ...SymphonyProjectStatusField }
        }
      }
    }
  }

  fragment SymphonyProjectStatusField on ProjectV2 {
    id
    number
    field(name: $statusField) {
      __typename
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
`;

export const UPDATE_PROJECT_STATUS_MUTATION = String.raw`
  mutation SymphonyUpdateProjectStatus(
    $projectId: ID!
    $itemId: ID!
    $fieldId: ID!
    $optionId: String!
    $statusField: String!
  ) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item {
        id
        statusValue: fieldValueByName(name: $statusField) {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue { id name updatedAt }
        }
      }
    }
  }
`;
