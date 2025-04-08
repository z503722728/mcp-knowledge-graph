#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import minimist from 'minimist';
import { isAbsolute } from 'path';

// Parse args and handle paths safely
const argv = minimist(process.argv.slice(2));
// Check for memory path in command line args or environment variable
let memoryPath = argv['memory-path'] || process.env.MEMORY_FILE_PATH;

// If a custom path is provided, ensure it's absolute
if (memoryPath && !isAbsolute(memoryPath)) {
    memoryPath = path.resolve(process.cwd(), memoryPath);
}

// Define the path to the JSONL file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use the custom path or default to the installation directory
const MEMORY_FILE_PATH = memoryPath || path.join(__dirname, 'memory.jsonl');

// We are storing our memory using entities, relations, and observations in a graph structure
interface Entity {
  name: string;
  entityType: string;
  aliases?: string[];
  observations: string[];
  createdAt: string;
  version: number;
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
  createdAt: string;
  version: number;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(MEMORY_FILE_PATH, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");
      return lines.reduce((graph: KnowledgeGraph, line) => {
        const item = JSON.parse(line);
        if (item.type === "entity") graph.entities.push(item as Entity);
        if (item.type === "relation") graph.relations.push(item as Relation);
        return graph;
      }, { entities: [], relations: [] });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({ type: "entity", ...e })),
      ...graph.relations.map(r => JSON.stringify({ type: "relation", ...r })),
    ];
    await fs.writeFile(MEMORY_FILE_PATH, lines.join("\n"));
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities = entities.filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name))
      .map(e => ({
        ...e,
        aliases: e.aliases || [],
        createdAt: new Date().toISOString(),
        version: e.version || 1
      }));
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const newRelations = relations.filter(r => !graph.relations.some(existingRelation =>
      existingRelation.from === r.from &&
      existingRelation.to === r.to &&
      existingRelation.relationType === r.relationType
    )).map(r => ({
      ...r,
      createdAt: new Date().toISOString(),
      version: r.version || 1
    }));
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const graph = await this.loadGraph();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      const newObservations = o.contents.filter(content => !entity.observations.includes(content));
      entity.observations.push(...newObservations);
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    await this.saveGraph(graph);
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        entity.observations = entity.observations.filter(o => !d.observations.includes(o));
      }
    });
    await this.saveGraph(graph);
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(r => !relations.some(delRelation =>
      r.from === delRelation.from &&
      r.to === delRelation.to &&
      r.relationType === delRelation.relationType
    ));
    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  // Very basic search function
  async searchNodes(queries: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities: Check if any query matches name, entityType, or observations
    const filteredEntities = graph.entities.filter(e =>
      queries.some(query =>
        e.name.toLowerCase().includes(query.toLowerCase()) ||
        e.entityType.toLowerCase().includes(query.toLowerCase()) ||
        e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
      )
    );

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }

  async updateEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const updatedEntities = entities.map(updateEntity => {
      const existingEntityIndex = graph.entities.findIndex(e => e.name === updateEntity.name);
      if (existingEntityIndex === -1) {
        throw new Error(`Entity with name ${updateEntity.name} not found`);
      }
      const existingEntity = graph.entities[existingEntityIndex];
      
      const newlyUpdatedEntity = {
        ...existingEntity,
        ...updateEntity,
        aliases: updateEntity.aliases !== undefined ? updateEntity.aliases : existingEntity.aliases,
        version: existingEntity.version + 1,
        createdAt: new Date().toISOString()
      };
      
      graph.entities[existingEntityIndex] = newlyUpdatedEntity;
      return newlyUpdatedEntity;
    });
    
    await this.saveGraph(graph);
    return updatedEntities;
  }

  async updateRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const updatedRelations = relations.map(updateRelation => {
      const existingRelation = graph.relations.find(r =>
        r.from === updateRelation.from &&
        r.to === updateRelation.to &&
        r.relationType === updateRelation.relationType
      );
      if (!existingRelation) {
        throw new Error(`Relation not found`);
      }
      return {
        ...existingRelation,
        ...updateRelation,
        version: existingRelation.version + 1,
        createdAt: new Date().toISOString()
      };
    });
    
    // Update relations in the graph
    updatedRelations.forEach(updatedRelation => {
      const index = graph.relations.findIndex(r =>
        r.from === updatedRelation.from &&
        r.to === updatedRelation.to &&
        r.relationType === updatedRelation.relationType
      );
      if (index !== -1) {
        graph.relations[index] = updatedRelation;
      }
    });
    
    await this.saveGraph(graph);
    return updatedRelations;
  }

  async getContextInfo(inputNames: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const foundCanonicalNames = new Set<string>();
    const MAX_RECENT_NON_ACTIVE = 5; // Keep the latest 5 non-active timestamped observations

    inputNames.forEach(inputName => {
      let found = false;
      // 1. Try exact match on name
      const exactMatch = graph.entities.find(e => e.name === inputName);
      if (exactMatch) {
        foundCanonicalNames.add(exactMatch.name);
        found = true;
      }

      // 2. Try matching aliases if no exact match found yet
      if (!found) {
        const aliasMatch = graph.entities.find(e => e.aliases?.includes(inputName));
        if (aliasMatch) {
          foundCanonicalNames.add(aliasMatch.name);
          // No need to set found = true, just add the canonical name
        }
      }
      
      // TODO: Consider adding Levenshtein distance check here as a fallback if still not found
    });

    // Filter entities based on found canonical names
    const filteredEntities = graph.entities
      .filter(e => foundCanonicalNames.has(e.name))
      .map(entity => {
          // Now filter the observations for this entity
          const activeObservations: string[] = [];
          const timestampedNonActive: { timestamp: Date; observation: string }[] = [];
          const untimestampedObservations: string[] = [];

          // Regex to parse "[timestamp] [S:Status] content" or "[timestamp] content"
          // Allows for optional status tag
          const observationRegex = /^\[([^\]]+)\](?:\s*\[S:([^\]]+)\])?\s*(.*)/;

          entity.observations.forEach(obs => {
              const match = obs.match(observationRegex);
              if (match) {
                  const timestampStr = match[1];
                  const status = match[2]?.trim().toUpperCase(); // Get status if present
                  const content = match[3];
                  const timestamp = new Date(timestampStr);

                  if (!isNaN(timestamp.getTime())) { // Check if timestamp is valid
                      if (status === 'ACTIVE') {
                          activeObservations.push(obs); // Keep original string
                      } else {
                          timestampedNonActive.push({ timestamp, observation: obs });
                      }
                  } else {
                      // Invalid timestamp format, treat as untimestamped
                      untimestampedObservations.push(obs);
                  }
              } else {
                  // No timestamp prefix found
                  untimestampedObservations.push(obs);
              }
          });

          // Sort timestamped non-active observations by date, descending (most recent first)
          timestampedNonActive.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

          // Take the top N most recent non-active timestamped observations
          const recentNonActive = timestampedNonActive
              .slice(0, MAX_RECENT_NON_ACTIVE)
              .map(item => item.observation);

          // Combine filtered observations: Active + Recent Non-Active + Untimestamped
          const filteredObservations = [
              ...activeObservations,
              ...recentNonActive,
              ...untimestampedObservations
          ];

          // Return the entity with filtered observations
          return { ...entity, observations: filteredObservations };
      });


    // Filter relations to only include those between the found (and now observation-filtered) entities
    const filteredRelations = graph.relations.filter(r =>
      foundCanonicalNames.has(r.from) && foundCanonicalNames.has(r.to)
    );

    return {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  }
}

const knowledgeGraphManager = new KnowledgeGraphManager();


// The server instance and tools exposed to Claude
const server = new Server({
  name: "@itseasy21/mcp-knowledge-graph",
  version: "1.0.7",
},    {
    capabilities: {
      tools: {},
    },
  },);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_entities",
        description: "Create multiple new entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The canonical name of the entity (e.g., Type-Name)" },
                  entityType: { type: "string", description: "The type of the entity (e.g., Character, Location)" },
                  aliases: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "Optional list of alternative names or aliases (e.g., just the Name part)" 
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents associated with the entity (e.g., 'Key: Value')"
                  },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description: "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity to add the observations to" },
                  contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add"
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description: "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to delete"
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description: "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity containing the observations" },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observations to delete"
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete"
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: { 
              type: "array",
              items: { type: "string" },
              description: "The search query to match against entity names, types, and observation content" },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description: "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
      {
        name: "update_entities",
        description: "Update multiple existing entities in the knowledge graph. Only fields provided will be updated.",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The canonical name of the entity to update" },
                  entityType: { type: "string", description: "The updated type of the entity" },
                  aliases: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "Optional updated list of alternative names or aliases. Providing this overwrites the existing list." 
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "The updated array of observation contents. Providing this overwrites the existing list."
                  },
                },
                required: ["name"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "update_relations",
        description: "Update multiple existing relations in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "get_context_info",
        description: "Retrieves detailed information for a specified list of entities and their direct relationships, attempting to match provided names against canonical names and aliases.",
        inputSchema: {
            type: "object",
            properties: {
                entityNames: { 
                    type: "array", 
                    items: { type: "string" }, 
                    description: "A list of entity names (or potential aliases) to retrieve context for." 
                }
            },
            required: ["entityNames"]
        }
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "create_entities":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createEntities(args.entities as Entity[]), null, 2) }] };
    case "create_relations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[]), null, 2) }] };
    case "add_observations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[] }[]), null, 2) }] };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[]);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[]);
      return { content: [{ type: "text", text: "Observations deleted successfully" }] };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[]);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "read_graph":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.readGraph(), null, 2) }] };
    case "search_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.searchNodes(args.query as string[]), null, 2) }] };
    case "open_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.openNodes(args.names as string[]), null, 2) }] };
    case "update_entities":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.updateEntities(args.entities as Entity[]), null, 2) }] };
    case "update_relations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.updateRelations(args.relations as Relation[]), null, 2) }] };
    case "get_context_info":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.getContextInfo(args.entityNames as string[]), null, 2) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
