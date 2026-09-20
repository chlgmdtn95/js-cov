# 과제 참고 노트 (내 정리용 — 제출 전 삭제)

> 정답 코드가 아니라 "어디에 뭐가 있고, 뭘 써서, 뭘 해야 하는지" 참고서.
> 실제 구현은 `src/coverage.ts`의 visitor들에 직접.

---

## 1. visitor 함수 안에서 쓸 수 있는 것들 (다 클로저로 접근 가능)

전부 `coverage.ts` constructor 안에 있어서 visitor 안에서 그냥 씀.

| 이름 | 위치 | 용도 |
|------|------|------|
| `code` | constructor 인자 | 원본 코드 문자열 (Range 만들 때) |
| `fcount` / `scount` / `bcount` | 99번 | 번호 카운터. `id = fcount++` 식 |
| `funcTarget` / `stmtTarget` / `branchTarget` | 102~104번 | id→위치 표. `xTarget[id] = Range.fromNode(...)` |
| `visitor` | 107번 | 순회에 넘기는 객체 |
| `walkStmts(stmts)` | 172번 | 문 리스트 → 마커 심은 리스트 |
| `walk.recursive(node, null, visitor)` | acorn-walk | 노드 하나부터 순회 |

**패턴 (walkStmts가 stmt로 하는 것 = 모든 계측의 기본):**
```
const id = Xcount++;
XTarget[id] = Range.fromNode(code, 노드);
마커 = createStmt(`__cov__.X.add(${id});`);
```

---

## 2. helper 도구 (이미 import 됨)

| 도구 | 시그니처 | 용도 |
|------|----------|------|
| `Range.fromNode(code, node)` | → Range | 위치 기록 |
| `createStmt("코드;")` | 문자열 → 문 노드 | 마커 만들기 |
| `createExpr("코드")` | 문자열 → 식 노드 | 식 만들기 |
| `createSeqExpr([a, b])` | → `(a, b)` | 초기값/기본값 감쌀 때 |
| `createReturnStmt(expr)` | → `return expr;` | 화살표 몸통 바꿀 때 |
| `createBlockStmt([문들])` | → `{ ... }` | 문들을 블록으로 |
| `toBlockStmt(문)` | → 블록 | 단일 문을 블록으로 (이미 블록이면 그대로) |
| `prependStmt(문, target)` | → 블록 | target 맨 앞에 문 하나 삽입 |

**주의:** 이 함수들은 값을 *돌려주는* 것. 트리를 바꾸려면 `node.xxx = 결과`로 **다시 대입**해야 함.

---

## 3. 노드별 필드 (AST Explorer로 확인 가능)

| 노드 | 주요 필드 | 비고 |
|------|----------|------|
| Function | `params`(배열), `body`, `expression` | body가 블록/식인지 확인 |
| BlockStatement | `body`(문 배열) | |
| StaticBlock | `body`(문 배열) | `static { }` |
| VariableDeclaration | `declarations`(배열) → 각 `.init` | init은 null 가능 |
| AssignmentPattern | `left`, `right` | right=기본값 |
| IfStatement | `test`, `consequent`, `alternate` | alternate=null 가능 |
| ConditionalExpression | `test`, `consequent`, `alternate` | `a ? b : c` |
| LogicalExpression | `left`, `operator`, `right` | `&&` `\|\|` `??` |
| SwitchStatement | `discriminant`, `cases`(배열) | |
| SwitchCase | `test`(null=default), `consequent`(문 배열) | |
| While/DoWhile | `test`, `body` | |
| For | `init`, `test`, `update`, `body` | |
| ForIn/ForOf | `left`, `right`, `body` | |
| LabeledStatement | `label`, `body` | 라벨은 루프에 직접 유지 |

---

## 4. visitor별 해야 할 일 (README 규칙 → 절차)

### [x] BlockStatement — 완료
`node.body = walkStmts(node.body)`

### [ ] StaticBlock — BlockStatement과 동일

### [x] WhileStatement — 완료
`node.body = toBlockStmt(node.body)` → `walk.recursive(node.body, null, visitor)`

### [ ] DoWhile / ForIn / ForOf — While과 body 처리 동일

### [ ] ForStatement — body는 While과 동일. + `init`/`test`/`update`에도 계측 대상 있을 수 있으니 순회

### [ ] Function
1. params 순회: `for (const p of func.params) walk.recursive(p, null, visitor)`
2. `const fid = fcount++; funcTarget[fid] = Range.fromNode(code, func)`
3. body가 BlockStatement면:
   - `func.body.body = walkStmts(func.body.body)`
   - 맨 앞에 `__cov__.func.add(fid);` 마커 prepend
4. body가 식이면(화살표):
   - stmt id 하나 발급 + 위치 기록(func.body)
   - 원래 body 순회
   - `func.body`를 `{ __cov__.func.add(fid); __cov__.stmt.add(sid); return 원래body; }`로 교체
   - `func.expression = false`

### [ ] VariableDeclaration
각 declarator의 `init`(있으면)을 `(__cov__.stmt.add(id), 원래init)`으로 감싸기 (createSeqExpr).
stmt id 발급 + 위치=Range.fromNode(code, init). init 안도 순회.

### [ ] AssignmentPattern
`right`를 `(__cov__.stmt.add(id), 원래right)`으로 감싸기. VariableDeclaration의 init과 동일 방식.

### [ ] IfStatement
- consequent를 블록으로(toBlockStmt) → 맨 앞 `__cov__.branch.add(A);` (위치=consequent) → 순회
- alternate 있으면: 블록으로 → 맨 앞 `branch.add(B)` (위치=alternate) → 순회
- alternate 없으면: else 새로 만들어 `branch.add(B)`만 (빈 range = if문 끝)
- test 안도 순회

### [ ] ConditionalExpression (`a ? b : c`)
- consequent → `(__cov__.branch.add(A), consequent)`
- alternate → `(__cov__.branch.add(B), alternate)`
- 위치는 각각 consequent/alternate. test/consequent/alternate 안도 순회

### [ ] LogicalExpression (`&&` `||` `??`)
- left, right **각 clause**를 `(__cov__.branch.add(id), clause)`로 감싸기
- 위치는 각 clause. 양쪽 안도 순회

### [ ] SwitchStatement
- 각 case의 consequent(문 배열) 맨 앞에 `__cov__.branch.add(id);` (위치=SwitchCase 전체)
- consequent는 문 리스트니까 walkStmts도 적용
- discriminant 순회

### [ ] LabeledStatement
- 라벨을 블록에 붙이면 `continue label` 깨짐 → 라벨은 loop body에 직접 유지
- body 순회 (stmt 마커는 walkStmts가 label 처리 부분에서 이미 함 — 182~189번 참고)

---

## 5. 함정 (README "Rules Pinned Down")

- declaration은 stmt 아님. 단 초기값(init)은 stmt.
- `||=` `&&=` `??=` `?.` 는 **브랜치 아님** (visitor 없어서 저절로 무시됨)
- 단일 문 body(if/else/loop)도 블록 취급 → id 받음
- `else if`의 nested if는 branch + stmt 둘 다
- switch fallthrough: 마커가 case consequent 첫 문 → 빈 case도 branch
- 구현 끝낸 visitor는 `todo(...)` 줄 **삭제** (안 지우면 에러 던짐)

---

## 6. 테스트

```
npm run test                                              # 전체 (100개)
npm run start coverage example/sort.js example/sort.json  # 직접 실행 눈으로
npx ts-mocha test/**/*.ts -g "sort"                       # sort만
```
채점: 내 결과 vs `example/*.expected.json` (개수 + 위치, id 숫자는 무시)
