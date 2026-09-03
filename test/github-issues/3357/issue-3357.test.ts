import "reflect-metadata"
import { expect } from "chai"
import sinon from "sinon"
import { Table } from "../../../src"
import type { Query } from "../../../src/driver/Query"
import { PostgresQueryRunner } from "../../../src/driver/postgres/PostgresQueryRunner"
import { TableColumn } from "../../../src/schema-builder/table/TableColumn"

// RdbmsSchemaBuilder's schema-diff path calls changeColumns(), which delegates
// each column to changeColumn(). These tests inspect that generated query plan.
describe("github issues > #3357 postgres character length SQL", () => {
    function makeRunner() {
        const driver: any = {
            searchSchema: "public",
            database: "testdb",
            uuidGenerator: "uuid_generate_v4()",
            parseTableName: (target: Table | string) => {
                const name = typeof target === "string" ? target : target.name
                return { schema: "public", tableName: name }
            },
            createFullType: (column: TableColumn) =>
                column.length
                    ? `${column.type}(${column.length})`
                    : column.type,
        }
        const dataSource: any = {
            namingStrategy: {
                primaryKeyName: () => "PK_issue_3357",
            },
            driver,
        }
        driver.dataSource = dataSource
        return new PostgresQueryRunner(driver, "master")
    }

    function characterColumn(
        name: string,
        type: "varchar" | "char" | "character",
        length: string,
    ) {
        return new TableColumn({ name, type, length, isNullable: true })
    }

    function capturedQueries(runner: PostgresQueryRunner) {
        const queries: { up: Query[]; down: Query[] } = { up: [], down: [] }
        sinon
            .stub(runner as any, "executeQueries")
            .callsFake(async (up: Query | Query[], down: Query | Query[]) => {
                queries.up = Array.isArray(up) ? up : [up]
                queries.down = Array.isArray(down) ? down : [down]
            })
        sinon.stub(runner as any, "replaceCachedTable")
        return queries
    }

    afterEach(() => sinon.restore())

    it("generates ALTER COLUMN TYPE instead of DROP COLUMN for varchar length growth", async () => {
        const runner = makeRunner()
        const oldColumn = characterColumn("value", "varchar", "50")
        const newColumn = characterColumn("value", "varchar", "51")
        const table = new Table({ name: "issue_3357", columns: [oldColumn] })
        const queries = capturedQueries(runner)
        const dropSpy = sinon.stub(runner, "dropColumn").resolves()
        const addSpy = sinon.stub(runner, "addColumn").resolves()

        await runner.changeColumns(table, [{ oldColumn, newColumn }])

        const sql = queries.up.map((query) => query.query).join("\n")
        expect(dropSpy.called).to.equal(false)
        expect(addSpy.called).to.equal(false)
        expect(sql).to.equal(
            'ALTER TABLE "issue_3357" ALTER COLUMN "value" TYPE varchar(51)',
        )
        expect(sql).not.to.contain("DROP COLUMN")
    })

    for (const type of ["char", "character"] as const) {
        it(`generates ALTER COLUMN TYPE for ${type} length-only changes`, async () => {
            const runner = makeRunner()
            const oldColumn = characterColumn("value", type, "50")
            const newColumn = characterColumn("value", type, "51")
            const table = new Table({
                name: "issue_3357",
                columns: [oldColumn],
            })
            const queries = capturedQueries(runner)
            const dropSpy = sinon.stub(runner, "dropColumn").resolves()

            await runner.changeColumn(table, oldColumn, newColumn)

            expect(dropSpy.called).to.equal(false)
            expect(queries.up.map((query) => query.query)).to.deep.equal([
                `ALTER TABLE "issue_3357" ALTER COLUMN "value" TYPE ${type}(51)`,
            ])
        })
    }

    it("retains DROP and ADD for a varchar-to-integer type-family change", async () => {
        const runner = makeRunner()
        const oldColumn = characterColumn("value", "varchar", "50")
        const newColumn = new TableColumn({
            name: "value",
            type: "integer",
            isNullable: true,
        })
        const table = new Table({ name: "issue_3357", columns: [oldColumn] })
        capturedQueries(runner)
        const dropSpy = sinon.stub(runner, "dropColumn").resolves()
        const addSpy = sinon.stub(runner, "addColumn").resolves()

        await runner.changeColumn(table, oldColumn, newColumn)

        expect(dropSpy.calledOnceWith(table, oldColumn)).to.equal(true)
        expect(addSpy.calledOnceWith(table, newColumn)).to.equal(true)
    })
})
