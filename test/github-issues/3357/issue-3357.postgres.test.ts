import "reflect-metadata"
import { expect } from "chai"
import type { DataSource, QueryRunner } from "../../../src"
import { Table } from "../../../src"
import {
    closeTestingConnections,
    createTestingConnections,
} from "../../utils/test-utils"

describe("github issues > #3357 postgres character length changes", () => {
    let dataSources: DataSource[] = []
    before(async () => {
        dataSources = await createTestingConnections({
            enabledDrivers: ["postgres"],
            dropSchema: true,
        })
    })
    after(() => closeTestingConnections(dataSources))

    function createCharacterTable(name: string, length: string) {
        return new Table({
            name,
            columns: [
                { name: "id", type: "integer", isPrimary: true },
                {
                    name: "value",
                    type: "varchar",
                    length,
                    isNullable: false,
                },
            ],
        })
    }

    async function createTableAndInsert(
        queryRunner: QueryRunner,
        table: Table,
        value: string,
    ) {
        await queryRunner.createTable(table)
        await queryRunner.query(
            `INSERT INTO "${table.name}" ("id", "value") VALUES ($1, $2)`,
            [1, value],
        )
    }

    it("preserves rows while increasing varchar length", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const queryRunner = dataSource.createQueryRunner()
                const table = createCharacterTable("issue_3357_grow", "50")
                await createTableAndInsert(queryRunner, table, "still here")
                const oldColumn = (await queryRunner.getTable(
                    table.name,
                ))!.findColumnByName("value")!
                const newColumn = oldColumn.clone()
                newColumn.length = "51"

                await queryRunner.changeColumn(table, oldColumn, newColumn)

                expect(
                    await queryRunner.query(
                        'SELECT "value" FROM "issue_3357_grow" WHERE "id" = $1',
                        [1],
                    ),
                ).to.deep.equal([{ value: "still here" }])
                expect(
                    (await queryRunner.getTable(table.name))!.findColumnByName(
                        "value",
                    )!.length,
                ).to.equal("51")
                await queryRunner.release()
            }),
        ))

    it("rejects a varchar length decrease with oversized data without dropping the column", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const queryRunner = dataSource.createQueryRunner()
                const table = createCharacterTable("issue_3357_shrink", "51")
                const oversizedValue = "x".repeat(51)
                await createTableAndInsert(queryRunner, table, oversizedValue)
                const oldColumn = (await queryRunner.getTable(
                    table.name,
                ))!.findColumnByName("value")!
                const newColumn = oldColumn.clone()
                newColumn.length = "50"

                await expect(
                    queryRunner.changeColumn(table, oldColumn, newColumn),
                ).to.be.rejected

                const unchangedTable = await queryRunner.getTable(table.name)
                expect(unchangedTable).not.to.be.undefined
                expect(
                    unchangedTable!.findColumnByName("value")!.length,
                ).to.equal("51")
                expect(
                    await queryRunner.query(
                        'SELECT "value" FROM "issue_3357_shrink" WHERE "id" = $1',
                        [1],
                    ),
                ).to.deep.equal([{ value: oversizedValue }])
                await queryRunner.release()
            }),
        ))

    it("changes varchar length and name in both migration directions", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const queryRunner = dataSource.createQueryRunner()
                const table = createCharacterTable("issue_3357_rename", "50")
                await createTableAndInsert(queryRunner, table, "preserved")
                const oldColumn = (await queryRunner.getTable(
                    table.name,
                ))!.findColumnByName("value")!
                const newColumn = oldColumn.clone()
                newColumn.name = "renamed_value"
                newColumn.length = "51"

                await queryRunner.changeColumn(table, oldColumn, newColumn)

                expect(
                    await queryRunner.query(
                        'SELECT "renamed_value" FROM "issue_3357_rename" WHERE "id" = $1',
                        [1],
                    ),
                ).to.deep.equal([{ renamed_value: "preserved" }])
                expect(
                    (await queryRunner.getTable(table.name))!.findColumnByName(
                        "renamed_value",
                    )!.length,
                ).to.equal("51")

                await queryRunner.executeMemoryDownSql()

                expect(
                    await queryRunner.query(
                        'SELECT "value" FROM "issue_3357_rename" WHERE "id" = $1',
                        [1],
                    ),
                ).to.deep.equal([{ value: "preserved" }])
                expect(
                    (await queryRunner.getTable(table.name))!.findColumnByName(
                        "value",
                    )!.length,
                ).to.equal("50")
                await queryRunner.release()
            }),
        ))
})
