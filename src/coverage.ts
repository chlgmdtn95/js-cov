import {
  Range,
  getString,
  log,
  warn,
  todo,
  parse,
  createExpr,
  createSeqExpr,
  createStmt,
  createBlockStmt,
  toBlockStmt,
  createReturnStmt,
  prependStmt,
} from './helper';

import dedent from 'dedent-js';

import acorn from 'acorn';
import {
  Node,
  Function,
  Statement,
  BlockStatement,
  LogicalExpression,
  VariableDeclaration,
  AssignmentPattern,
  SwitchStatement,
  IfStatement,
  ConditionalExpression,
  Expression,
} from 'acorn';
import walk from 'acorn-walk';

import { generate } from 'astring';

// Coverage target
interface CoverageTarget {
  [key: number]: Range;
}

// Covered set
export class CoverSet {
  covered: Set<number>;
  target: CoverageTarget;
  total: number;

  constructor(target: CoverageTarget) {
    this.covered = new Set();
    this.target = target;
    this.total = Object.keys(target).length;
  }

  // Add a covered id
  add = (id: number): void => {
    this.covered.add(id);
  }

  // Conversion to string
  toString = (
    showDetail: boolean = false,
    code: string | undefined = undefined,
  ): string => {
    const { covered, target, total } = this;
    const { size } = covered;
    const ratio = (size / total) * 100;
    const ids = Object.keys(target).map(Number);
    const sorted = Array.from(ids).sort((a, b) => a - b);
    let str = `${size}/${total} (${ratio.toFixed(2)}%)`;
    if (showDetail) {
      for (const id of sorted) {
        str += '\n' + ('      ') + (covered.has(id) ? '*' : ' ');
        const range = target[id];
        str += ` ${id}: ${target[id]}`;
        if (code) {
          const { start, end } = range;
          str += ' -- ' + code.substring(start.index, end.index);
        }
      }
    }
    return `${str}`;
  }
}

// Coverage of the code by statement and branch
export class Coverage {
  code: string;
  modified: string;
  runner?: () => void;
  func: CoverSet;
  stmt: CoverSet;
  branch: CoverSet;

  constructor(code: string) {
    // Parse the code
    let ast = parse(code);

    // Counters for functions, statements, and branches
    let fcount = 0, scount = 0, bcount = 0;

    // Coverage targets
    let funcTarget: CoverageTarget = {};
    let stmtTarget: CoverageTarget = {};
    let branchTarget: CoverageTarget = {};

    // Recursive visitor for the AST
    const visitor: walk.RecursiveVisitors<any> = {
      Function(func) {
        // 1. Visit `params` first: default values may contain statements and
        //    branches (see `AssignmentPattern`).
        for (const p of func.params)
          walk.recursive(p, null, visitor);

        // 2. Issue a function id and record `Range.fromNode(code, func)`.
        const fid = fcount++;
        funcTarget[fid] = Range.fromNode(code, func);
        
        // 3. If `body` is a `BlockStatement`, instrument its statements and
        //    prepend `__cov__.func.add(<id>);`.
        if (func.body.type === 'BlockStatement')
        {
          func.body.body = walkStmts(func.body.body);
          func.body = prependStmt(createStmt( `__cov__.func.add(${fid});`), func.body);
        }
        // 4. Otherwise `body` is an expression (arrow function): replace it by
        //    `{ __cov__.func.add(<id>); __cov__.stmt.add(<sid>); return <body>; }`
        //    and set `func.expression = false`.
        else
        {
          walk.recursive(func.body, null, visitor);
          const sid = scount++;
          stmtTarget[sid] = Range.fromNode(code, func.body);
          func.body = createBlockStmt([
            createStmt(`__cov__.func.add(${fid})`),
            createStmt(`__cov__.stmt.add(${sid})`),
            createReturnStmt(func.body)
          ]);
          func.expression = false;
        }
        // todo("Function");
      },
      VariableDeclaration(decl) {
        for (const p of decl.declarations)
        {
          walk.recursive(p, null ,visitor);
          if (!p.init)
            continue;
          const sid = scount++;
          stmtTarget[sid] = Range.fromNode(code, p.init);
          // walk.recursive(p.id, null, visitor);
          p.init = createSeqExpr([
            createExpr(`__cov__.stmt.add(${sid})`), p.init
          ]);
        }
        // todo("VariableDeclaration");
      },
      AssignmentPattern(pattern) {
        walk.recursive(pattern.right, null, visitor);
        const sid = scount++;
        stmtTarget[sid] = Range.fromNode(code, pattern.right);
        pattern.right = createSeqExpr([
          createExpr(`__cov__.stmt.add(${sid})`), pattern.right
        ]);
        
        walk.recursive(pattern.left, null, visitor);
        // const sid2 = scount++;
        // stmtTarget[sid2] = Range.fromNode(code, pattern.left);
        // pattern.left = createSeqExpr([
        //   createExpr(`__cov__.stmt.add(${sid})`), pattern.left
        // ]);
        // todo("AssignmentPattern");
      },
      BlockStatement(node) {
        node.body = walkStmts(node.body);
        // todo("BlockStatement");
      },
      SwitchStatement(stmt) {
        walk.recursive(stmt.discriminant, null, visitor);
        for (const c of stmt.cases)
        {
          // walk.recursive(c, null, visitor);
          c.consequent = walkStmts(c.consequent);

          if (c.test)
            walk.recursive(c.test, null, visitor);

          const bid = bcount++;
          branchTarget[bid] = Range.fromNode(code, c);
          c.consequent.unshift(createStmt(`__cov__.branch.add(${bid})`));
          // const sid = scount++;
          // branchTarget[sid] = Range.fromNode(code, c);
          // for (const cons of c.consequent)
          // {
          //   cons = prependStmt(createStmt(`__cov__.branch.add(${bid})`), cons);
          // }
        }

        // todo("SwitchStatement");
      },
      StaticBlock(node) {
        node.body = walkStmts(node.body);
        // todo("StaticBlock");
      },
      IfStatement(stmt) {
        walk.recursive(stmt.test, null, visitor);

        stmt.consequent = toBlockStmt(stmt.consequent);
        walk.recursive(stmt.consequent, null, visitor);
        const bid = bcount++;
        branchTarget[bid] = Range.fromNode(code, stmt.consequent);
        stmt.consequent = prependStmt(createStmt(`__cov__.branch.add(${bid})`), stmt.consequent);
        
        if (stmt.alternate)
        {
          stmt.alternate = toBlockStmt(stmt.alternate);
          walk.recursive(stmt.alternate, null, visitor);
          const bid = bcount++;
          branchTarget[bid] = Range.fromNode(code, stmt.alternate);
          stmt.alternate = prependStmt(createStmt(`__cov__.branch.add(${bid})`), stmt.alternate);
        }
        else
          {
            const bid = bcount++;
            branchTarget[bid] = Range.fromCode(code, stmt.end, stmt.end);
            stmt.alternate = createBlockStmt([createStmt(`__cov__.branch.add(${bid});`)]);
          }
          // todo("IfStatement");
        },
        ConditionalExpression(expr) {
          walk.recursive(expr.test, null, visitor);
          const bid = bcount++;
          // branchTarget[bid] = Range.fromNode(code, expr.test);
          
          walk.recursive(expr.consequent, null, visitor);
          const bid2 = bcount++;
          branchTarget[bid2] = Range.fromNode(code, expr.consequent);
          expr.consequent = createSeqExpr([createExpr(`__cov__.branch.add(${bid2})`), expr.consequent]);;

          walk.recursive(expr.alternate, null, visitor);
          const bid3 = bcount++;
          branchTarget[bid3] = Range.fromNode(code, expr.alternate);
          expr.alternate = createSeqExpr([createExpr(`__cov__.branch.add(${bid3})`), expr.alternate]);

        // todo("ConditionalExpression");
      },
      LogicalExpression(node) {
        walk.recursive(node.left, null, visitor);
        if (node.left.type != "LogicalExpression")
        {
          const bid = bcount++;
          branchTarget[bid] = Range.fromNode(code, node.left);
          node.left = createSeqExpr([createExpr(`__cov__.branch.add(${bid})`), node.left]);
        }  
        walk.recursive(node.right, null, visitor);
        if (node.right.type != "LogicalExpression")
        {
          const bid = bcount++;
          branchTarget[bid] = Range.fromNode(code, node.right);
          node.right = createSeqExpr([createExpr(`__cov__.branch.add(${bid})`), node.right]);
        }  

        // todo("LogicalExpression");
      },
      LabeledStatement(node) {
        // Keep the label directly on a loop body: `continue label;` is illegal
        // when `label` labels a block.
        walk.recursive(node.body, null, visitor);
        // todo("LabeledStatement");
      },
      WhileStatement(node) {
        walk.recursive(node.test, null, visitor);
        
        node.body = toBlockStmt(node.body);
        walk.recursive(node.body, null, visitor);
        // todo("WhileStatement");
      },
      DoWhileStatement(node) {
        walk.recursive(node.test, null, visitor);
        node.body = toBlockStmt(node.body);
        walk.recursive(node.body, null, visitor);
        // todo("DoWhileStatement");
      },
      ForStatement(node) {
        if (node.init)
          walk.recursive(node.init, null, visitor);
        if (node.test)
          walk.recursive(node.test, null, visitor);
        if (node.update)
          walk.recursive(node.update, null, visitor);
        node.body = toBlockStmt(node.body);
        walk.recursive(node.body, null, visitor);
        // todo("ForStatement");
      },
      ForInStatement(node) {
        node.body = toBlockStmt(node.body);
        walk.recursive(node.body, null, visitor);
        // todo("ForInStatement");
      },
      ForOfStatement(node) {
        // if (node.init)
        //   walk.recursive(node.init, null, visitor);
        if (node.left)
          walk.recursive(node.left, null, visitor);
        if (node.right)
          walk.recursive(node.right, null, visitor);
        node.body = toBlockStmt(node.body);
        walk.recursive(node.body, null, visitor);
        // node.body = toBlockStmt(node.body);
        // walk.recursive(node.body, null, visitor);
        // todo("ForOfStatement");
      },
    }

    // Instrument a sequence of statements (a block, a function body, or the
    // consequent of a switch case) -- given as a guide for the visitors above.
    // For every `Statement` that is not a `Declaration`, issue a statement id,
    // record its range, and insert `__cov__.stmt.add(<sid>);` right before it.
    // Then visit the statement so that nested constructs are instrumented too.
    // Note that ids may be numbered in any order: the tests compare the source
    // ranges of the test requirements, not the ids.
    function walkStmts(stmts: Statement[]): Statement[] {
      let newStmts = [];
      for (const stmt of stmts) {
        if (!stmt.type.endsWith('Declaration')) {
          const sid = scount++;
          stmtTarget[sid] = Range.fromNode(code, stmt);
          newStmts.push(createStmt(`__cov__.stmt.add(${sid});`));
        }
        // `label: body` -- the body is a statement too, but it cannot be
        // wrapped without changing the label's meaning, so its marker goes here.
        let labeled: Statement = stmt;
        while (labeled.type === 'LabeledStatement') {
          labeled = labeled.body;
          if (labeled.type === 'BlockStatement') break;
          const sid = scount++;
          stmtTarget[sid] = Range.fromNode(code, labeled);
          newStmts.push(createStmt(`__cov__.stmt.add(${sid});`));
        }
        newStmts.push(stmt);
        walk.recursive(stmt, null, visitor);
      }
      return newStmts;
    }

    // Recursively visit the AST
    walk.recursive(ast, null, visitor);

    // Fill the fields of the coverage object
    this.code = code;
    this.modified = generate(ast);
    this.func = new CoverSet(funcTarget);
    this.stmt = new CoverSet(stmtTarget);
    this.branch = new CoverSet(branchTarget);
    try {
      this.runner = eval(`(() => {
        const __cov__ = this;
        const orig = ${this.modified};
        function func() {
          try { return orig.apply(null, arguments); } catch (e) { }
        };
        return func;
      })();`);
    } catch(_) { warn('The given code is not runnable with arguments.'); }
  }

  // Run the instrumented code with the inputs
  run = (inputs: any[]): void => {
    for (const input of inputs) this.runSingle(input);
  }

  // Run the instrumented code with a single input
  runSingle = (input: any): void => {
    if (this.runner) this.runner.apply(null, input);
    else warn('The given code is not runnable with arguments.');
  }

  // Conversion to string
  toString = (
    showModified: boolean = false,
    showDetail: boolean = false,
  ): string => {
    const { code, func: f, stmt: s, branch: b } = this;
    let str: string = '';
    if (showModified) str += `Modified: ${this.modified}\n`;
    str += `Coverage:` + '\n';
    if (f.total > 0) str += `- func: ${f.toString(showDetail)}\n`;
    if (s.total > 0) str += `- stmt: ${s.toString(showDetail)}\n`;
    if (b.total > 0) str += `- branch: ${b.toString(showDetail)}\n`;
    return str.trim();
  }
}
