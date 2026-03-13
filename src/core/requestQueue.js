import PQueue from "p-queue";

const queue = new PQueue({
    concurrency: 1,
    interval: 1000,
    intervalCap: 2
});

export function enqueue(task) {
    return queue.add(task);
}