---
name: compiler
description: Resolves compiler-level bugs in Antlisp. Use when you can see bugs in generated antssembly.
---

# Debugging Compiler Failures

Once we have identified a compiler bug, we need to follow a strict process to resolve it. Compiler bugs are notoriously difficult to diagnose and resolve, and a false fix can cause failures elsewhere. As a result, we always use this pattern:

## 1. Create a minimal end-to-end demonstration of the failure

Find a minimal reproducing example of the alisp code that produces the bad antssembly. Write a unit.alisp file and the built-in assertions to demonstrate this. During this step, you SHOULD NOT inspect compiler internals. If this is absolutely necessary, you may, but DO NOT attempt to fix the bug. If it is impossible to create a test that demonstrates the bug, stop and discuss with the user how we can modify the test framework to allow exposing it.

Try to start with the original alisp file, and remove pieces from it until it is as small as possible while still failing.

## 2. Identify the compiler pipeline component responsible for the bug

Now formulate hypotheses about which parts of the compiler are responsible for this bug. Eliminate hypotheses by writing node unit tests in the relevant test files. Once you have written a minimal unit test demonstrating the bugs in the relevant pipeline sections, remove the other unit tests you added, which do not help to demonstrate the bug at hand.

## 3. Fix the bug

Now you can attempt to fix the bug. Focus on just the unit test that you created and the other unit tests in the compiler, ignoring the failing end-to-end test for now.

Once the unit test is passing, stop and reflect. You have identified and fixed a real compiler bug, but that doesn't mean that the work is done.

## 4. Run the end-to-end test again

Run the end-to-end test again. If the tests do not pass, you should return to step 2. Do not revert your code: the last time you were in step 2 you identified a real compiler bug and fixed it. If the tests pass, continue.

## 5. Test with the original bug report alisp

With the end-to-end test working, it should be possible to compile and test the original alisp file. If not, you should return to step 1. Do not revert your code: just as before, you have identified and fixed real copiler bugs; there are simply more to fix. If the original file passes: Congratulations! You are finished.
