package main

const dummyExperiment = `#sweep

#imports
"sort"

#setup
values := []int{9, 3, 7, 1, 8, 2, 6, 4, 5}

#bench
sort.Ints(values)

#cleanup
if !sort.IntsAreSorted(values) {
	panic("values were not sorted")
}
`
