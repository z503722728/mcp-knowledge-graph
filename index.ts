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

// Proposing edit to index.ts to extract Observations into a top-level structure

// 1. Define new Observation interface and update Entity/KnowledgeGraph
interface Observation {
  id: string; // Unique ID for each observation
  entityName: string; // Links back to the Entity it describes
  content: string; // The core text content
  timestamp?: string; // Optional ISO timestamp field
  status?: 'Active' | 'Resolved' | 'Background' | 'Archived' | null; // Optional status field
  createdAt: string;
  version: number;
}

interface Entity {
  name: string;
  entityType: string;
  aliases?: string[];
  // observations: string[]; // REMOVED
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
  observations: Observation[]; // ADDED
}

// Define a specific type for the update payload
interface EntityUpdatePayload {
  name: string; // Required: The current name of the entity to find
  newName?: string; // Optional: The new name for the entity
  entityType?: string; // Optional
  aliases?: string[]; // Optional
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private async loadGraph(): Promise<KnowledgeGraph> {
    // Initialize graph structure explicitly typed
    let graph: KnowledgeGraph = { entities: [], relations: [], observations: [] };
    try {
        const data = await fs.readFile(MEMORY_FILE_PATH, "utf-8");
        const lines = data.split("\n").filter(line => line.trim() !== "");

        // Load all data first, explicitly typing the accumulator in reduce
        graph = lines.reduce((acc: KnowledgeGraph, line: string): KnowledgeGraph => {
            try { // Add try-catch for robustness during parsing
                const item = JSON.parse(line);
                if (item.type === "entity" && item.name && item.entityType) { // Basic validation
                    acc.entities.push(item as Entity);
                } else if (item.type === "relation" && item.from && item.to && item.relationType) { // Basic validation
                    acc.relations.push(item as Relation);
                } else if (item.type === "observation" && item.id && item.entityName && typeof item.content === 'string') { // Basic validation
                    acc.observations.push(item as Observation);
                } else {
                    console.warn(`[KnowledgeGraphManager] Skipping invalid line during load: ${line}`);
                }
            } catch (parseError) {
                console.warn(`[KnowledgeGraphManager] Error parsing line during load, skipping: ${line}`, parseError);
            }
            return acc; // Return the accumulator
        }, { entities: [], relations: [], observations: [] }); // Initial value for reduce

    } catch (error) {
        if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
            console.log("[KnowledgeGraphManager] Memory file not found, starting with empty graph.");
            // graph remains the initial empty object { entities: [], relations: [], observations: [] }
        } else {
           console.error("[KnowledgeGraphManager] Error loading graph:", error);
           // Depending on severity, might want to return empty graph or rethrow
           // Let's rethrow for now, as other errors might be critical
           throw error;
        }
    }

    return graph; // Return the graph as loaded
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const dir = path.dirname(MEMORY_FILE_PATH);
    try { await fs.mkdir(dir, { recursive: true }); }
    catch (mkdirError) { if (mkdirError instanceof Error && (mkdirError as any).code !== 'EEXIST') { console.error(`Failed to ensure directory exists for saving: ${dir}`, mkdirError); throw mkdirError; } }
    const validEntities = graph.entities.filter(e => e && typeof e === 'object' && e.name && e.entityType);
    const validRelations = graph.relations.filter(r => r && typeof r === 'object' && r.from && r.to && r.relationType);
    const validObservations = graph.observations.filter(o => o && typeof o === 'object' && o.id && o.entityName && typeof o.content === 'string');
    const lines = [ ...validEntities.map(e => JSON.stringify({ type: "entity", ...e })), ...validRelations.map(r => JSON.stringify({ type: "relation", ...r })), ...validObservations.map(o => JSON.stringify({ type: "observation", ...o })), ];
    try { await fs.writeFile(MEMORY_FILE_PATH, lines.join("\n") + "\n"); }
    catch (writeError) { console.error(`Error writing graph to ${MEMORY_FILE_PATH}:`, writeError); throw writeError; }
  }

  // --- Helper to parse observation string into structured data (New) ---
  private parseObservationContent(content: string): { timestamp?: string; status?: Observation['status']; text: string } {
      const observationRegex = /^\[([^\]]+)\](?:\s*\[S:([^\]]+)\])?\s*(.*)/;
      const match = content.match(observationRegex);
      if (match) {
          const timestampStr = match[1];
          const statusStr = match[2]?.trim().toUpperCase();
          const text = match[3] || ''; // Ensure text is always a string

          let status: Observation['status'] = null;
          switch (statusStr) {
              case 'ACTIVE': status = 'Active'; break;
              case 'RESOLVED': status = 'Resolved'; break;
              case 'BACKGROUND': status = 'Background'; break;
              case 'ARCHIVED': status = 'Archived'; break;
          }

          // Basic validation for timestamp format (ISO 8601)
          const timestamp = Date.parse(timestampStr) ? timestampStr : undefined;

          return { timestamp, status, text };
      } else {
          // No prefix, treat as plain text content
          return { text: content };
      }
  }

  // --- Helper to generate a unique Observation ID (Simple version) ---
  private generateObservationId(): string {
      return `obs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // --- NEW: Method for Startup Cleanup ---
  async performStartupCleanup(): Promise<void> {
      console.log("[KnowledgeGraphManager] Performing startup cleanup of archived observations...");
      let graph = await this.loadGraph(); // Load the potentially unclean graph
      const initialCount = graph.observations.length;
      // Filter out archived observations
      graph.observations = graph.observations.filter(obs => obs.status !== 'Archived');
      const removedCount = initialCount - graph.observations.length;

      if (removedCount > 0) {
          console.log(`[KnowledgeGraphManager] Startup Cleanup: Removed ${removedCount} archived observations. Saving cleaned graph.`);
          await this.saveGraph(graph); // Save the cleaned graph back to the file
      } else {
          console.log("[KnowledgeGraphManager] Startup Cleanup: No archived observations found to remove.");
      }
  }

  // --- Modified Methods ---

  async createEntities(entities: Partial<Entity>[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities = entities
        .filter(e => e.name && e.entityType && !graph.entities.some(existing => existing.name === e.name))
        .map(e => ({
            name: e.name!,
            entityType: e.entityType!,
            aliases: e.aliases || [],
            createdAt: new Date().toISOString(),
            version: e.version || 1
        } as Entity)); // Ensure type correctness
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  // createRelations remains the same structurally
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


  async addObservations(observationsInput: { entityName: string; contents: string[] }[]): Promise<{ addedObservationIds: string[] }[]> {
      const graph = await this.loadGraph();
      const results: { addedObservationIds: string[] }[] = [];

      for (const input of observationsInput) {
          // Check if entity exists
          const entity = graph.entities.find(e => e.name === input.entityName);
          if (!entity) {
              // Optionally throw error or just skip and log
              console.warn(`Entity '${input.entityName}' not found. Skipping observations.`);
              results.push({ addedObservationIds: [] }); // Indicate no observations added for this entity
              continue;
          }

          const addedIds: string[] = [];
          for (const content of input.contents) {
              // Parse the content first to get status and timestamp
              const parsed = this.parseObservationContent(content);
              
              // Special handling for Archived status - look for existing observations to update
              // MODIFIED: Extend this logic to other non-Active statuses like Resolved, Background
              if (parsed.status && parsed.status !== 'Active') { // Check if status is defined and not 'Active'
                  // Find similar observations for this entity that aren't already archived
                  // We'll compare the text content without status/timestamp prefixes
                  const textContentNoPrefixes = parsed.text.trim();
                  let matchFound = false;
                  
                  // Look through existing observations to find a match to update
                  for (let i = 0; i < graph.observations.length; i++) {
                      const obs = graph.observations[i];
                      // Only update if the existing observation is currently 'Active' 
                      // (or maybe has no status? Decide if null status should be updatable)
                      // And ensure the entity matches
                      if (obs.entityName === input.entityName && obs.status === 'Active') { 
                          // Parse this observation's content to get just the text part
                          const existingParsed = this.parseObservationContent(obs.content);
                          const existingTextNoPrefixes = existingParsed.text.trim();
                          
                          // If the core text content matches, update this observation instead of adding new
                          if (existingTextNoPrefixes === textContentNoPrefixes) {
                              // Update the observation's status, content, and timestamp
                              graph.observations[i] = {
                                  ...obs,
                                  content: content, // Update with new full content string
                                  status: parsed.status, // Update to the new status (Resolved, Background, Archived)
                                  timestamp: parsed.timestamp || obs.timestamp, // Use new timestamp if provided, else keep old
                                  version: obs.version + 1,
                              };
                              addedIds.push(obs.id); // Add the existing ID to the result
                              matchFound = true;
                              console.log(`[KnowledgeGraphManager] Updated existing observation ${obs.id} for entity '${input.entityName}' to status '${parsed.status}' based on content match.`);
                              break; // Stop searching once a match is updated
                          }
                      }
                  }
                  
                  // If a match was found and updated, skip adding a new observation for this content item
                  if (matchFound) {
                      continue; // Skip to next content item
                  }
                  // If no match was found to update, fall through to the regular add logic below
                  // This might happen if there's no 'Active' observation with matching text, 
                  // or if the incoming status was 'Active' itself.
              }
              
              // Regular flow - check for duplicates (exact match) before adding NEW observation
              const alreadyExists = graph.observations.some(obs => 
                  obs.entityName === input.entityName && obs.content === content
              );

              if (!alreadyExists) {
                  const newObservation: Observation = {
                      id: this.generateObservationId(),
                      entityName: input.entityName,
                      content: content, // Store original full string for now
                      timestamp: parsed.timestamp,
                      status: parsed.status,
                      // text: parsed.text, // Could store just the text part if preferred
                      createdAt: new Date().toISOString(),
                      version: 1,
                  };
                  graph.observations.push(newObservation);
                  addedIds.push(newObservation.id);
              }
          }
          results.push({ addedObservationIds: addedIds });
      }

      if (results.some(r => r.addedObservationIds.length > 0)) {
          await this.saveGraph(graph);
      }
      return results;
  }


  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    // Delete entities
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    // Delete relations involving these entities
    graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    // Delete observations associated with these entities
    graph.observations = graph.observations.filter(o => !entityNames.includes(o.entityName));
    await this.saveGraph(graph);
  }

  // deleteObservations now needs to decide *how* to identify observations to delete.
  // Option 1: By ID (requires IDs to be passed in, more precise)
  // Option 2: By entityName + content match (current implementation's spirit)
  // Let's stick with Option 2 for now to minimize tool interface changes.
  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    let changed = false;
    deletions.forEach(d => {
      const initialCount = graph.observations.length;
      graph.observations = graph.observations.filter(obs =>
        // Keep if entityName doesn't match OR if entityName matches but content is NOT in the deletion list
        !(obs.entityName === d.entityName && d.observations.includes(obs.content))
      );
      if (graph.observations.length < initialCount) {
        changed = true;
      }
    });
    if (changed) {
      await this.saveGraph(graph);
    }
  }

  // deleteRelations remains the same structurally
  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(r => !relations.some(delRelation =>
      r.from === delRelation.from &&
      r.to === delRelation.to &&
      r.relationType === delRelation.relationType
    ));
    await this.saveGraph(graph);
  }


  // readGraph remains the same
  async readGraph(): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    return graph;
  }


  // searchNodes needs to search the new observations structure
  async searchNodes(queries: string[]): Promise<KnowledgeGraph> {
      const graph = await this.loadGraph();
      const lowerCaseQueries = queries.map(q => q.toLowerCase());

      // Filter entities based on name, type, aliases
      const filteredEntities = graph.entities.filter(e =>
          lowerCaseQueries.some(query =>
              e.name.toLowerCase().includes(query) ||
              e.entityType.toLowerCase().includes(query) ||
              (e.aliases && e.aliases.some(alias => alias.toLowerCase().includes(query)))
          )
      );

      // Find entities whose *observations* match
      const entitiesMatchedByObservation = new Set<string>();
      graph.observations.forEach(obs => {
          if (lowerCaseQueries.some(query => obs.content.toLowerCase().includes(query))) {
              entitiesMatchedByObservation.add(obs.entityName);
          }
      });

      // Combine entity sets and get unique names
      const entityNamesFromObservations = Array.from(entitiesMatchedByObservation);
      const matchingEntityNames = new Set([
          ...filteredEntities.map(e => e.name),
          ...entityNamesFromObservations
      ]);

      // Get the final list of unique matching entities
      const finalEntities = graph.entities.filter(e => matchingEntityNames.has(e.name));
      const finalEntityNamesSet = new Set(finalEntities.map(e => e.name)); // Use the final list for relation filtering

      // Filter relations
      const filteredRelations = graph.relations.filter(r =>
          finalEntityNamesSet.has(r.from) && finalEntityNamesSet.has(r.to)
      );

      // Filter observations for matching entities (Archived already removed at startup)
      const filteredObservations = graph.observations.filter(o => finalEntityNamesSet.has(o.entityName));

      return {
          entities: finalEntities,
          relations: filteredRelations,
          observations: filteredObservations,
      };
  }

  // openNodes needs to also retrieve associated observations
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Filter relations
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    // Filter observations for matching entities (Archived already removed at startup)
    const filteredObservations = graph.observations.filter(o => filteredEntityNames.has(o.entityName));

    return {
      entities: filteredEntities,
      relations: filteredRelations,
      observations: filteredObservations,
    };
  }

  // updateEntities updated to use the specific payload type and handle renaming
  async updateEntities(entitiesToUpdate: EntityUpdatePayload[]): Promise<{ updatedEntities: Entity[], warnings: string[] }> {
      const graph = await this.loadGraph();
      const updatedEntitiesResult: Entity[] = [];
      const warnings: string[] = [];
      let graphModified = false;

      entitiesToUpdate.forEach(updateData => {
          const currentName = updateData.name;
          const newName = updateData.newName?.trim(); // Trim whitespace from new name

          const existingEntityIndex = graph.entities.findIndex(e => e.name === currentName);
          if (existingEntityIndex === -1) {
              warnings.push(`Entity with name '${currentName}' not found for update. Skipping.`);
              return; // Skip this update
          }

          const existingEntity = graph.entities[existingEntityIndex];
          let finalName = currentName;

          // --- Name Change Logic ---
          if (newName && newName !== currentName) {
              // Check for potential name collision before renaming
              const collisionIndex = graph.entities.findIndex(e => e.name === newName);
              // Ensure collision check doesn't flag the entity itself if no other properties are changing
              if (collisionIndex !== -1 && collisionIndex !== existingEntityIndex) {
                  warnings.push(`Cannot rename entity '${currentName}' to '${newName}'. An entity with the name '${newName}' already exists. Skipping rename for this entity.`);
                  // Decide if we should proceed with other updates (type/aliases) or skip entirely.
                  // Let's skip the entire update for this entity to avoid partial updates.
                  return;
              }
              // If no collision, set the final name to the new name
              finalName = newName;
          }
          // --- End Name Change Logic ---

          // Create the updated entity, applying only provided fields
          const newlyUpdatedEntity: Entity = {
              ...existingEntity, // Start with existing data
              name: finalName, // Apply the final name (could be old or new)
              // Conditionally update other fields
              ...(updateData.entityType !== undefined && { entityType: updateData.entityType }),
              ...(updateData.aliases !== undefined && { aliases: updateData.aliases }),
              // Update version and timestamp
              version: existingEntity.version + 1,
              createdAt: new Date().toISOString() // Consider if this should be modifiedAt
          };

          // Replace the old entity with the updated one in the graph
          graph.entities[existingEntityIndex] = newlyUpdatedEntity;
          updatedEntitiesResult.push(newlyUpdatedEntity);
          graphModified = true; // Mark graph as modified

          // --- Update Relations and Observations if name changed ---
          if (finalName !== currentName) {
              console.log(`[KnowledgeGraphManager] Renaming entity from '${currentName}' to '${finalName}'. Updating relations and observations...`);
              let refsUpdatedCount = 0;
              // Update relations
              graph.relations = graph.relations.map(relation => {
                  let updated = false;
                  if (relation.from === currentName) {
                      relation.from = finalName;
                      relation.version += 1; // Bump version on relation update
                      updated = true;
                  }
                  if (relation.to === currentName) {
                      relation.to = finalName;
                      // Avoid double version bump if both from/to matched
                      if (!updated) relation.version += 1;
                      updated = true;
                  }
                  if(updated) refsUpdatedCount++;
                  return relation;
              });

              // Update observations
              graph.observations = graph.observations.map(observation => {
                  if (observation.entityName === currentName) {
                      observation.entityName = finalName;
                      observation.version += 1; // Bump version on observation update
                      refsUpdatedCount++;
                  }
                  return observation;
              });
              console.log(`[KnowledgeGraphManager] Updated ${refsUpdatedCount} references in relations and observations for the renamed entity.`);
          }
          // --- End Update Relations and Observations ---
      });

      if (graphModified) {
          await this.saveGraph(graph);
      }
      // Return both updated entities and any warnings generated
      return { updatedEntities: updatedEntitiesResult, warnings: warnings };
  }


  // updateRelations remains the same structurally
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
        ...updateRelation, // Apply updates from input
        version: existingRelation.version + 1,
        createdAt: new Date().toISOString() // Update timestamp
      };
    });

    // Update relations in the graph (Need to find and replace)
    updatedRelations.forEach(updatedRelation => {
        const index = graph.relations.findIndex(r =>
            r.from === updatedRelation.from &&
            r.to === updatedRelation.to &&
            r.relationType === updatedRelation.relationType
        );
        if (index !== -1) {
            graph.relations[index] = updatedRelation;
        } else {
            // This case should ideally not happen based on the find logic above, but good to handle
            console.warn("Could not find relation to update in graph array, though it was found earlier.");
        }
    });


    await this.saveGraph(graph);
    return updatedRelations; // Return the updated relations
  }



  // getContextInfo needs significant changes to fetch observations separately and filter/sort them
  async getContextInfo(inputNames: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph(); // Loads the already cleaned graph
    const initialMatchingNames = new Set<string>();
    const TOTAL_OBSERVATION_LIMIT = 25; // Define a single limit for all observations
    const MAX_RECENT_RELATIONS = 50; // NEW: Limit for recent relations

    // 1. Find canonical names matching input names/aliases (Unchanged)
    inputNames.forEach(inputName => {
      const exactMatch = graph.entities.find(e => e.name === inputName);
      if (exactMatch) {
        initialMatchingNames.add(exactMatch.name);
      } else {
        const aliasMatch = graph.entities.find(e => e.aliases?.includes(inputName));
        if (aliasMatch) {
          initialMatchingNames.add(aliasMatch.name);
        }
      }
    });

    // If no initial entities found, return empty graph
    if (initialMatchingNames.size === 0) {
        return { entities: [], relations: [], observations: [] };
    }

    // 2. Find relations *directly involving* the initial entities (MODIFIED)
    const directlyInvolvingRelations = graph.relations.filter(r =>
      initialMatchingNames.has(r.from) || initialMatchingNames.has(r.to)
    );

    // 3. Collect unique entity names involved: initial entities + entities connected by the direct relations (MODIFIED)
    const finalEntityNames = new Set<string>(initialMatchingNames);
    directlyInvolvingRelations.forEach(r => {
      finalEntityNames.add(r.from);
      finalEntityNames.add(r.to);
    });

    // 4. Filter entities based on the final set of names (Uses the modified finalEntityNames)
    const finalEntities = graph.entities.filter(e => finalEntityNames.has(e.name));

    // 5. Filter, sort, and limit the relations (MODIFIED)
    const sortedRelations = directlyInvolvingRelations
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); // Sort newest first
    const finalRelations = sortedRelations.slice(0, MAX_RECENT_RELATIONS); // Apply limit

    // 6. Filter all observations for the final entities (Unchanged filtering)
    const relevantObservationsRaw = graph.observations.filter(o => finalEntityNames.has(o.entityName));

    // 7. NEW SORTING LOGIC: Sort all relevant observations primarily by timestamp (desc), secondarily by createdAt (desc)
    const sortedObservations = relevantObservationsRaw.sort((a, b) => {
        const tsA = a.timestamp ? new Date(a.timestamp) : null;
        const tsB = b.timestamp ? new Date(b.timestamp) : null;
        const validTsA = tsA && !isNaN(tsA.getTime());
        const validTsB = tsB && !isNaN(tsB.getTime());

        // Prioritize valid timestamps
        if (validTsA && !validTsB) return -1; // a has timestamp, b doesn't -> a comes first
        if (!validTsA && validTsB) return 1;  // b has timestamp, a doesn't -> b comes first

        // If both have valid timestamps, compare them (newest first)
        if (validTsA && validTsB) {
            const timeDiff = tsB!.getTime() - tsA!.getTime();
            if (timeDiff !== 0) return timeDiff; // If timestamps differ, return the difference
        }

        // If timestamps are the same or both invalid, compare by createdAt (newest first)
        const createdA = new Date(a.createdAt);
        const createdB = new Date(b.createdAt);
        // Assume createdAt is always valid for simplicity, add checks if needed
        return createdB.getTime() - createdA.getTime();
    });

    // 8. Limit the total number of observations
    const finalObservations = sortedObservations.slice(0, TOTAL_OBSERVATION_LIMIT);

    // 9. Return the filtered entities, relations, and sorted/limited observations
    return {
      entities: finalEntities,
      relations: finalRelations,
      observations: finalObservations,
    };
  }
} // End of KnowledgeGraphManager class

// Instantiate the manager globally so it can be used by main and server handlers
const knowledgeGraphManager = new KnowledgeGraphManager();


// The server instance and tools exposed to Claude
const server = new Server({
  name: "@itseasy21/mcp-knowledge-graph", // Update name if needed
  version: "1.1.1", // Increment version due to significant change
}, {
  capabilities: {
    tools: {},
  },
},);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Ensure all tool schemas are complete and correct
  return {
    tools: [
      {
          name: "create_entities",
          description: "Create multiple new entities (without observations) in the knowledge graph. Add observations separately using 'add_observations'.",
          inputSchema: {
              type: "object",
              properties: {
                  entities: {
                      type: "array",
                      items: {
                          type: "object",
                          properties: {
                              name: { type: "string", description: "The canonical name (e.g., Type-Name)" },
                              entityType: { type: "string", description: "The type (e.g., Character)" },
                              aliases: { type: "array", items: { type: "string" }, description: "Optional aliases" }
                          },
                          required: ["name", "entityType"],
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
        description: "Add new observations associated with existing entities. Parses content for timestamp/status.",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity the observation is about" },
                  contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add (e.g., '[ISO_Date] [S:Status] Text')"
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
        description: "Delete multiple entities and their associated relations and observations from the knowledge graph",
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
        description: "Delete specific observations by matching entity name and content string",
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
                    description: "An array of observation content strings to delete"
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
        description: "Read the entire knowledge graph (entities, relations, observations)",
        inputSchema: {
          type: "object",
          properties: {}, // No arguments needed
        },
      },
      {
        name: "search_nodes",
        description: "Search for entities based on query (matching name, type, aliases, or observation content). Returns matching entities, their relations, and their observations.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "array",
              items: { type: "string" },
              description: "The search query terms" },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description: "Open specific nodes by name. Returns the entities, their relations, and their observations.",
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
          description: "Update fields (like type, aliases, or name) of existing entities. If 'newName' is provided, also updates all references in relations and observations.",
          inputSchema: {
              type: "object",
              properties: {
                  entities: {
                      type: "array",
                      items: {
                          type: "object",
                          properties: {
                              name: { type: "string", description: "The current name of the entity to update" },
                              newName: { type: "string", description: "Optional: The new name for the entity" },
                              entityType: { type: "string", description: "Optional new type" },
                              aliases: { type: "array", items: { type: "string" }, description: "Optional new list of aliases" }
                          },
                          required: ["name"], // Only current name is strictly required to find the entity
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
                  relationType: { type: "string", description: "The type of the relation to identify it" },
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
        description: "Retrieves detailed context for specified entities (matching names/aliases). Returns entities, their relations, and a filtered/sorted list of their observations (Active first, then recent history, then untimestamped).",
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

  // Adjust handlers to match modified manager methods and return types
  switch (name) {
    case "create_entities":
      // Note: The input type here needs adjustment based on schema changes if we were fully precise
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createEntities(args.entities as any[]), null, 2) }] };
    case "create_relations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[]), null, 2) }] };
    case "add_observations":
      // Return type changed to { addedObservationIds: string[] }[]
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[] }[]), null, 2) }] };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[]);
      return { content: [{ type: "text", text: "Entities and associated relations/observations deleted successfully" }] }; // Updated text
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[]);
      return { content: [{ type: "text", text: "Observations deleted successfully based on content match" }] }; // Updated text
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[]);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "read_graph":
      // Return type now includes top-level observations array
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.readGraph(), null, 2) }] };
    case "search_nodes":
      // Return type now includes top-level observations array
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.searchNodes(args.query as string[]), null, 2) }] };
    case "open_nodes":
      // Return type now includes top-level observations array
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.openNodes(args.names as string[]), null, 2) }] };
    case "update_entities":
       // Use the specific payload type for casting - function now returns { updatedEntities: [], warnings: [] }
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.updateEntities(args.entities as EntityUpdatePayload[]), null, 2) }] };
    case "update_relations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.updateRelations(args.relations as Relation[]), null, 2) }] };
    case "get_context_info":
      // Return type now includes top-level observations array (filtered)
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.getContextInfo(args.entityNames as string[])) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// main function remains the same

async function main() {
  // Perform startup cleanup using the global manager instance
  await knowledgeGraphManager.performStartupCleanup();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server (v1.1.1 - Startup Cleanup & Limits) running on stdio"); // Update version/startup message
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
